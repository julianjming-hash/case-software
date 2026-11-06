import {loadPrivateStyle} from './private-style.mjs';
const FEEDBACK_CSS='__FEEDBACK_PRESENTATION_CSS_URL__';
export const loadFeedbackStyle=()=>loadPrivateStyle(new URL(FEEDBACK_CSS==='__FEEDBACK_PRESENTATION_CSS_URL__'?'/src/client/feedback-presentation.css':FEEDBACK_CSS,location.origin).href);
