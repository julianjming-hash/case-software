// Card 40d (Julian, 2026-10-17: "page it and shrink text"): the ended projector's summary takes two pages when its route and
// objectives together would run past about eight lines at 1280 × 720, the route first and the objectives second, so neither
// clips. The room machine, the room's page count and the projector all read this one rule.
const LINES = 8, CHARS_PER_LINE = 60;
const lines = ({ route = [], objectives = [] }) => route.length + objectives.reduce((n, text) => n + Math.max(1, Math.ceil(String(text).length / CHARS_PER_LINE)), 0);
/** 1 or 2: the summary pages before the first result. */
export const summaryPages = (debrief = {}) => (debrief.route?.length && debrief.objectives?.length && lines(debrief) > LINES ? 2 : 1);
