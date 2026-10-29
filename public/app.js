let pendingMutation = Promise.resolve();

function showMutationError() {
  let error = document.querySelector('main [role="alert"]');
  if (!error) {
    error = document.createElement("p");
    error.className = "error";
    error.setAttribute("role", "alert");
    document.querySelector("main")?.prepend(error);
  }
  error.textContent = "Shelf could not confirm that change. Check your shelf before trying again.";
}

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
  const submitter = event.submitter;
  if (submitter instanceof HTMLButtonElement) submitter.disabled = true;

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
      if (submitter instanceof HTMLButtonElement) submitter.disabled = false;
      showMutationError();
    }
  });

  await pendingMutation;
});
