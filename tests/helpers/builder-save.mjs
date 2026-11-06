// Test-only save completion: an autosave may win before the harness asks for a manual save.
import assert from 'node:assert/strict';

export function builderSaveCheckpoint({ revision, writes }) {
  assert.ok(Number.isSafeInteger(revision) && revision >= 0, 'checkpoint needs a saved revision');
  assert.ok(Array.isArray(writes), 'checkpoint needs the observed writes');
  return Object.freeze({ revision, writes: writes.length });
}

// Serialized by locator.evaluate: the check and native activation run in one browser task.
// This completion aid does not claim Playwright pointer/actionability coverage.
export function activateBuilderSave(button) {
  if (button.disabled) return 'disabled';
  button.click();
  return 'clicked';
}

export function assertBuilderSaveEvidence(evidence, baseline, expectedPair) {
  const { revision, pair, writes, readbacks } = evidence;
  assert.ok(Number.isSafeInteger(revision), 'invalid saved revision');
  assert.ok(writes.length > baseline.writes, 'no write after the mutation checkpoint');
  assert.ok(revision > baseline.revision, 'saved revision did not advance after the mutation checkpoint');
  const write = writes.at(-1), receipt = write.receipt, readback = readbacks.at(-1);
  assert.ok(typeof write.operationId === 'string' && write.operationId.length > 0, 'missing write operation identity');
  assert.ok(receipt && receipt.status === 'saved', 'missing successful save receipt');
  assert.equal(receipt.operationId, write.operationId, 'receipt operation does not match the write');
  assert.equal(receipt.revision, revision, 'receipt revision does not match the saved draft');
  assert.ok(typeof receipt.intentDigest === 'string' && receipt.intentDigest.length > 0, 'missing paired intent digest');
  assert.ok(readback, 'missing paired draft readback');
  assert.equal(readback.revision, revision, 'readback revision does not match the receipt');
  assert.equal(readback.intentDigest, receipt.intentDigest, 'readback digest does not match the receipt');
  assert.deepEqual(readback.pair, write.pair, 'readback differs from the exact submitted document/metadata');
  assert.deepEqual(pair, write.pair, 'current stored pair differs from the acknowledged write');
  if (expectedPair !== undefined) assert.deepEqual(pair, expectedPair, 'saved pair differs from the expected edit');
  return receipt;
}

export function assertBuilderSaveAcknowledgement(acknowledgement, receipt) {
  assert.equal(acknowledgement.text, 'Saved', 'the client has not acknowledged the saved draft');
  assert.equal(acknowledgement.title, `Saved as revision ${receipt.revision}`, 'client Saved revision is stale or mismatched');
}

export async function waitForBuilderSave(page, { expect, baseline, evidence, expectedPair }) {
  // Keep the existing assertion deadline. Disabled alone, an old Saved label or a counted PUT cannot pass. A later
  // autosave may land while this waits (two edits written separately under load): every check re-reads the latest
  // receipt, and the client must acknowledge that one, never a receipt captured before it.
  const status = page.locator('.builder-save-state');
  const settled = async () => {
    const receipt = assertBuilderSaveEvidence(evidence(), baseline, expectedPair);
    assertBuilderSaveAcknowledgement(await status.evaluate(node => ({ text: node.textContent, title: node.title })), receipt);
    return receipt;
  };
  await expect.poll(async () => {
    try { await settled(); return true; }
    catch { return false; }
  }, { message: 'a post-mutation receipt, exact paired draft readback and the client Saved acknowledgement of that receipt' }).toBe(true);
  return settled();
}

export async function saveBuilderDraft(page, options) {
  const button = page.getByRole('button', { name: 'Save draft', exact: true });
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'More', exact: true }).click();
  const activation = await button.evaluate(activateBuilderSave);
  options.onActivation?.(activation);
  const receipt = await waitForBuilderSave(page, options);
  return { activation, receipt };
}
