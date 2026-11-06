// Drive the served shared combobox through its visible options; preserve the filter/form assertions.
export async function chooseOption(control, label) {
  await control.click();
  const id = await control.getAttribute('aria-controls');
  await control.page().locator(`[id="${id}"]`).getByRole('option', { name: label, exact: true }).click();
}
