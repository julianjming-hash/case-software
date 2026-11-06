// Shared durable vote shape, independent of delivery and audience renderers.
import {isUuidV7} from '../shared/ids.mjs';
export const OUTBOX_LIMIT = 20;
export const isVoteResponse = response => {
  if (!response || Object.keys(response).length !== 1) return false;
  if ('text' in response) return typeof response.text === 'string';
  if ('option_id' in response) return isUuidV7(response.option_id);
  const choices = response.option_ids ?? response.order;
  return Array.isArray(choices) && choices.length > 0 && choices.every(isUuidV7) && new Set(choices).size === choices.length;
};

