package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

var backupName = regexp.MustCompile(`^bonfire-[0-9]{8}T[0-9]{6}Z-[a-f0-9-]{32,36}\.dump\.enc$`)

type backupFile struct {
	Name   string    `json:"name"`
	Target string    `json:"target"`
	Bytes  int64     `json:"bytes"`
	At     time.Time `json:"at"`
}

func newS3() (*minio.Client, string, string, error) {
	ep, bucket, key, secret := os.Getenv("BONFIRE_S3_ENDPOINT"), os.Getenv("BONFIRE_S3_BUCKET"), os.Getenv("BONFIRE_S3_ACCESS_KEY"), os.Getenv("BONFIRE_S3_SECRET_KEY")
	if ep == "" && bucket == "" && key == "" && secret == "" {
		return nil, "", "", nil
	}
	if ep == "" || bucket == "" || key == "" || secret == "" {
		return nil, "", "", errors.New("S3-Konfiguration unvollständig")
	}
	prefix := strings.Trim(os.Getenv("BONFIRE_S3_PREFIX"), "/")
	if prefix != "" {
		prefix += "/"
	}
	c, err := minio.New(ep, &minio.Options{Creds: credentials.NewStaticV4(key, secret, ""), Secure: os.Getenv("BONFIRE_S3_USE_HTTP") != "true", Region: os.Getenv("BONFIRE_S3_REGION")})
	return c, bucket, prefix, err
}

func (b *backupWorker) putS3(ctx context.Context, name, path string) error {
	if b.s3 == nil {
		return errors.New("S3 nicht eingerichtet")
	}
	_, err := b.s3.FPutObject(ctx, b.bucket, b.prefix+name, path, minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

func (b *backupWorker) listFiles(ctx context.Context, target string) ([]backupFile, error) {
	files := []backupFile{}
	if target == "s3" {
		if b.s3 == nil {
			return files, errors.New("S3 nicht eingerichtet")
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		n := 0
		for obj := range b.s3.ListObjects(ctx, b.bucket, minio.ListObjectsOptions{Prefix: b.prefix + "bonfire-", Recursive: false}) {
			if obj.Err != nil {
				return nil, obj.Err
			}
			n++
			if n > 10000 {
				return nil, errors.New("Zu viele S3-Objekte im Präfix")
			}
			name := strings.TrimPrefix(obj.Key, b.prefix)
			if backupName.MatchString(name) {
				files = append(files, backupFile{name, target, obj.Size, obj.LastModified})
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	} else {
		entries, err := os.ReadDir(backupHome)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || !backupName.MatchString(e.Name()) {
				continue
			}
			i, err := e.Info()
			if err != nil {
				return nil, err
			}
			files = append(files, backupFile{e.Name(), target, i.Size(), i.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].At.After(files[j].At) })
	return files, nil
}

func (b *backupWorker) openArchive(ctx context.Context, target, name string) (io.ReadCloser, error) {
	if !backupName.MatchString(name) {
		return nil, errors.New("Ungültige Sicherungsdatei")
	}
	switch target {
	case "local", "upload":
		dir := backupHome
		if target == "upload" {
			dir = filepath.Join(dir, "uploads")
		}
		root, err := os.OpenRoot(dir)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		before, err := root.Lstat(name)
		if err != nil || !before.Mode().IsRegular() {
			return nil, errors.New("backup file not found")
		}
		file, err := root.Open(name)
		if err != nil {
			return nil, err
		}
		after, err := file.Stat()
		if err != nil || !os.SameFile(before, after) {
			return nil, errors.Join(errors.New("backup file changed while opening"), file.Close())
		}
		return file, nil
	case "s3":
		if b.s3 == nil {
			return nil, errors.New("S3 nicht eingerichtet")
		}
		key := b.prefix + name
		meta, err := b.s3.StatObject(ctx, b.bucket, key, minio.StatObjectOptions{})
		if err != nil {
			return nil, err
		}
		if meta.Size > archiveLimit+(64<<20) {
			return nil, errors.New("Sicherung überschreitet Größenlimit")
		}
		return b.s3.GetObject(ctx, b.bucket, key, minio.GetObjectOptions{})
	}
	return nil, errors.New("Ungültiges Sicherungsziel")
}

func (b *backupWorker) prune(ctx context.Context, target string, days int) error {
	if days == 0 {
		return nil
	}
	cutoff := time.Now().AddDate(0, 0, -days)
	if target == "s3" {
		if b.s3 == nil {
			return errors.New("S3 is not configured")
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		var newest minio.ObjectInfo
		objects := b.s3.ListObjects(ctx, b.bucket, minio.ListObjectsOptions{Prefix: b.prefix + "bonfire-"})
		for object := range objects {
			if object.Err != nil {
				return object.Err
			}
			if !backupName.MatchString(strings.TrimPrefix(object.Key, b.prefix)) {
				continue
			}
			if newest.Key == "" || object.LastModified.After(newest.LastModified) {
				object, newest = newest, object
			}
			if object.Key != "" && object.LastModified.Before(cutoff) {
				if err := b.s3.RemoveObject(ctx, b.bucket, object.Key, minio.RemoveObjectOptions{}); err != nil {
					return err
				}
			}
		}
		return ctx.Err()
	}
	files, err := b.listFiles(ctx, target)
	if err != nil {
		return err
	}
	for i, f := range files {
		if i == 0 || !f.At.Before(cutoff) {
			continue
		}
		err = os.Remove(filepath.Join(backupHome, f.Name))
		if err != nil {
			return err
		}
	}
	return nil
}
