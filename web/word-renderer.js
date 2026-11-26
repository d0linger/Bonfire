import { renderAsync } from "docx-preview";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
addEventListener(
  "message",
  async (e) => {
    if (
      e.source !== parent ||
      e.origin !== location.origin ||
      typeof e.data?.id !== "string" ||
      !(e.data.docx instanceof Uint8Array)
    )
      return;
    try {
      const root = document.querySelector("#pages");
      await renderAsync(e.data.docx, root, root, {
        renderAltChunks: false,
        renderChanges: false,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        ignoreFonts: true,
        breakPages: true,
      });
      await document.fonts.ready;
      await Promise.all(
        [...root.querySelectorAll("img")].map((img) => img.decode()),
      );
      const pages = [...root.querySelectorAll("section.docx")];
      if (!pages.length || pages.length > 50)
        throw Error("Das Word-Layout benötigt 1 bis 50 Seiten.");
      if (e.data.mode === "preview") {
        const sheetWidth = Math.max(
          ...pages.map((page) => page.getBoundingClientRect().width),
        );
        const fit = () => {
          root.style.zoom = String(
            Math.min(
              1,
              (document.documentElement.clientWidth - 16) / sheetWidth,
            ),
          );
        };
        document.body.style.margin = "0";
        root.style.overflow = "hidden";
        const wrap = root.querySelector(".docx-wrapper");
        if (wrap) wrap.style.padding = "8px 0";
        fit();
        addEventListener("resize", fit);
        parent.postMessage({ id: e.data.id, pages: pages.length }, e.origin);
        return;
      }
      const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
      for (const [i, page] of pages.entries()) {
        const rect = page.getBoundingClientRect();
        if (
          Math.abs((rect.width * 25.4) / 96 - 210) > 3 ||
          Math.abs((rect.height * 25.4) / 96 - 297) > 4
        )
          throw Error(
            "Dankesbrief benötigt A4 hoch. Bei Überlauf einen Seitenumbruch setzen.",
          );
        const image = await html2canvas(page, {
          scale: 1.6,
          backgroundColor: "#ffffff",
          logging: false,
        });
        const context = image.getContext("2d");
        for (const picture of page.querySelectorAll("img")) {
          const b = picture.getBoundingClientRect();
          if (!picture.naturalWidth || b.width <= 0 || b.height <= 0)
            throw Error("Eingebettetes Bild ist nicht darstellbar.");
          const sx = image.width / rect.width,
            sy = image.height / rect.height;
          context.drawImage(
            picture,
            (b.left - rect.left) * sx,
            (b.top - rect.top) * sy,
            b.width * sx,
            b.height * sy,
          );
        }
        if (i) pdf.addPage();
        pdf.addImage(image.toDataURL("image/png"), "PNG", 0, 0, 210, 297);
      }
      const bytes = pdf.output("arraybuffer");
      parent.postMessage({ id: e.data.id, pdf: bytes }, e.origin, [bytes]);
    } catch (error) {
      parent.postMessage(
        {
          id: e.data.id,
          error: error.message || "Word-Layout nicht darstellbar.",
        },
        e.origin,
      );
    }
  },
  false,
);
