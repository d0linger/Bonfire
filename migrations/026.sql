-- Keep account identities and their workspace grants while renaming the roles.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = CASE role
    WHEN 'Leitung' THEN 'Admin'
    WHEN 'Kassa' THEN 'Write'
    WHEN 'Prüfung' THEN 'Read'
END;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('Admin','Write','Read'));
