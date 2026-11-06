// Trend chart blocks (card 59 M1, CASE-263): the block's contract, apart from slide-document.mjs so the chart has one
// home (slide-document.mjs imports it and passes its checks and SLIDE_LIMITS). Values, times and axis bounds are the author's exact decimal text; nothing is interpolated, smoothed or judged.
export const TREND_SCALES = Object.freeze(['time', 'category']);
export const TREND_STYLES = Object.freeze(['line', 'points']);
/** An authored decimal: optional minus, up to 7 integer and 4 fraction digits. Text, so trailing zeros survive. */
export const TREND_NUMBER = /^-?\d{1,7}(?:\.\d{1,4})?$/;

// A trend chart draws only what the author typed (card 59): exact decimal text, explicit axis bounds and units, no
// interpolation, smoothing or reference range. A value outside the axis is never clipped; it stops readiness.
export function validateTrend(trend, at, { text, rows, keys, claim, fail, flag }, SLIDE_LIMITS) {
  if (trend.caption !== undefined) text(trend.caption, `${at}/caption`, SLIDE_LIMITS.caption);
  text(trend.x_label, `${at}/x_label`, SLIDE_LIMITS.trendLabel, 1); text(trend.y_label, `${at}/y_label`, SLIDE_LIMITS.trendLabel, 1);
  text(trend.x_unit, `${at}/x_unit`, SLIDE_LIMITS.unit); text(trend.y_unit, `${at}/y_unit`, SLIDE_LIMITS.unit);
  if (!TREND_SCALES.includes(trend.scale)) fail('enum', `${at}/scale`, `one of ${TREND_SCALES.join(', ')}`);
  if (!TREND_STYLES.includes(trend.style)) fail('enum', `${at}/style`, `one of ${TREND_STYLES.join(', ')}`);
  if (typeof trend.values_shown !== 'boolean') fail('type', `${at}/values_shown`, 'must be a boolean');
  const number = (value, valueAt, required) => {
    if (typeof value !== 'string') { fail('type', valueAt, 'must be number text'); return null; }
    if (value === '') { if (required) flag('required', valueAt, 'needs a number'); return null; }
    if (!TREND_NUMBER.test(value)) { fail('number', valueAt, 'must be a number such as 4.8 or -12'); return null; }
    return Number(value);
  };
  const min = number(trend.y_min, `${at}/y_min`, true), max = number(trend.y_max, `${at}/y_max`, true);
  if (min !== null && max !== null && !(min < max)) flag('axis_range', `${at}/y_max`, 'the axis top must be above its bottom');
  rows(trend.points, `${at}/points`, SLIDE_LIMITS.trendPoints, (point, pointAt) => {
    keys(point, ['id', 'label', 'at'], pointAt); claim(point.id, `${pointAt}/id`);
    text(point.label, `${pointAt}/label`, SLIDE_LIMITS.trendPointLabel, 1);
    // A category scale keeps any typed times, unused, so switching back to time loses nothing.
    number(point.at, `${pointAt}/at`, trend.scale === 'time');
  });
  const points = Array.isArray(trend.points) ? trend.points : [];
  if (points.length < 2 && Array.isArray(trend.points)) flag('too_few', `${at}/points`, 'a trend needs at least two points');
  // Time positions are the author's own numbers, strictly increasing; the chart never reorders them.
  if (trend.scale === 'time') {
    const times = points.map(point => typeof point?.at === 'string' && TREND_NUMBER.test(point.at) ? Number(point.at) : null);
    if (times.every(value => value !== null) && times.some((value, index) => index && value <= times[index - 1])) flag('time_order', `${at}/points`, 'times must increase from left to right');
  }
  rows(trend.series, `${at}/series`, SLIDE_LIMITS.trendSeries, (series, seriesAt) => {
    keys(series, ['id', 'label', 'values'], seriesAt); claim(series.id, `${seriesAt}/id`);
    text(series.label, `${seriesAt}/label`, SLIDE_LIMITS.trendLabel, 1);
    if (!Array.isArray(series.values) || series.values.length !== points.length) { fail('trend_shape', `${seriesAt}/values`, `must have exactly one value per point (${points.length})`); return; }
    let any = false;
    series.values.forEach((value, index) => {
      const valueAt = `${seriesAt}/values/${index}`, n = number(value, valueAt, false);
      if (n === null) return;
      any = true;
      if (min !== null && max !== null && (n < min || n > max)) flag('out_of_axis', valueAt, 'is outside the axis; widen the axis or correct the value');
    });
    if (!any) flag('empty_series', seriesAt, 'a series needs at least one value');
  });
}

