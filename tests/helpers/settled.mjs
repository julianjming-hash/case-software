// Wait until running CSS transitions finish, so a check such as axe colour contrast reads the settled colours, never a
// frame mid-way through a theme change. Infinite animations (spinners) are not transitions and are never awaited.
export async function settled(page) {
  // Transitions and finite animations (arrival fades); infinite ones (spinners) never finish and are skipped. The play
  // state is polled rather than the finished promise: Chromium can leave that promise unresolved after a theme switch.
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && (animation instanceof CSSTransition
    || (animation instanceof CSSAnimation && Number.isFinite(animation.effect?.getComputedTiming?.().endTime)))));
}
