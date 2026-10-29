let pendingMutation = Promise.resolve();
let mutationError = "";
let addRecoveryValues = [];

const mutationErrorMessage =
  "Shelf could not confirm that change. Check your shelf before trying again.";

function showMutationError(message) {
  let error = document.querySelector("main [data-mutation-error]");
  if (!error) {
    error = document.createElement("p");
    error.className = "error";
    error.setAttribute("role", "alert");
    error.setAttribute("data-mutation-error", "");
    document.querySelector("main")?.prepend(error);
  }
  error.textContent = message;
}

function restoreAddValues(values) {
  const form = document.querySelector("form.add");
  if (!(form instanceof HTMLFormElement)) return;

  for (const [name, value] of values) {
    const control = form.elements.namedItem(name);
    if (control && "value" in control) control.value = value;
  }
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
  const addValues = form.classList.contains("add")
    ? [...body.entries()].filter((entry) => typeof entry[1] === "string")
    : [];
  const submitter = event.submitter;
  if (submitter instanceof HTMLButtonElement) submitter.disabled = true;
  if (mutationError) {
    mutationError = "";
    addRecoveryValues = [];
  }

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
      if (mutationError) {
        restoreAddValues(addRecoveryValues);
        showMutationError(mutationError);
      }
    } catch {
      if (submitter instanceof HTMLButtonElement) submitter.disabled = false;
      mutationError = mutationErrorMessage;
      if (addValues.length) addRecoveryValues = addValues;
      restoreAddValues(addRecoveryValues);
      showMutationError(mutationError);
    }
  });

  await pendingMutation;
});
