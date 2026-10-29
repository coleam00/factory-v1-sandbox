let pendingMutation = Promise.resolve();

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.method !== "post") return;

  if (form.classList.contains("delete-form") && !confirm("Remove this book from your shelf?")) {
    event.preventDefault();
    return;
  }

  event.preventDefault();
  const action = form.action;
  const body = new FormData(form);

  pendingMutation = pendingMutation.then(async () => {
    try {
      const response = await fetch(action, {
        method: "POST",
        body,
      });
      const nextPage = new DOMParser().parseFromString(await response.text(), "text/html");
      const currentMain = document.querySelector("main");
      const nextMain = nextPage.querySelector("main");

      if (!currentMain || !nextMain) {
        throw new Error("Shelf response did not contain the page content");
      }
      currentMain.replaceWith(nextMain);
    } catch {
      window.location.reload();
    }
  });

  await pendingMutation;
});
