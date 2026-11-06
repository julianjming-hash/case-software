// The ten group tints (card 30); the renderer's GROUPS and the SQL allow-list name the same ten.
export const GROUP_TINTS = Object.freeze(['petrol', 'sage', 'olive', 'ochre', 'coral', 'rose', 'plum', 'periwinkle', 'sky', 'neutral']);
export const isTint = value => typeof value === 'string' && GROUP_TINTS.includes(value);
export const tintOf = value => isTint(value) ? value : 'neutral';
