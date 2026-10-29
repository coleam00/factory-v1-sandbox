document.querySelectorAll(".delete-form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!confirm("Remove this book from your shelf?")) event.preventDefault();
  });
});
