// Render the generated Word file inside the local renderer's isolated document.
export async function displayProof(host, blob) {
  const frame = document.createElement("iframe");
  frame.title = "Druckvorschau der Arbeitsfassung";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      removeEventListener("message", receive);
      if (error) {
        frame.remove();
        reject(Error(error));
      } else resolve();
    };
    const receive = (event) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.contentWindow ||
        event.data?.id !== id
      )
        return;
      finish(event.data.error);
    };
    const timer = setTimeout(
      () => finish("Druckvorschau konnte nicht geladen werden."),
      30000,
    );
    addEventListener("message", receive);
    frame.onload = () =>
      frame.contentWindow.postMessage(
        { mode: "preview", id, docx: bytes },
        location.origin,
        [bytes.buffer],
      );
    frame.src = "/word-renderer.html";
    host.replaceChildren(frame);
  });
}
