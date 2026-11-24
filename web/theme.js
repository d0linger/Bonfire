// Runs in the head so returning users get their chosen colors on first paint.
(() => {
  const key = "bonfire-theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const meta = document.querySelector('meta[name="theme-color"]');
  let preference;
  function apply(value) {
    preference = value === "light" || value === "dark" ? value : "system";
    const effective =
      preference === "system"
        ? system.matches
          ? "dark"
          : "light"
        : preference;
    document.documentElement.dataset.theme = effective;
    meta.content = effective === "dark" ? "#222730" : "#ffffff";
    const button = document.getElementById("theme-mode");
    if (button) {
      button.setAttribute("aria-pressed", String(effective === "dark"));
      button.title =
        effective === "dark"
          ? "Zum Hellmodus wechseln"
          : "Zum Dunkelmodus wechseln";
    }
  }
  function restore() {
    try {
      apply(localStorage.getItem(key));
    } catch {
      apply("system");
    }
  }
  restore();
  system.addEventListener("change", () => apply(preference));
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) restore();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-mode");
    apply(preference);
    button.addEventListener("click", () => {
      apply(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
      );
      try {
        localStorage.setItem(key, preference);
      } catch {
        // Browsers with storage disabled keep the choice for this page.
      }
    });
  });
})();
