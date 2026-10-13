/** Play / shuttle the two transports (the program one wakes the WebAudio mixer first: it needs a user gesture). */
import { mixer } from "./audio";
import { program, source } from "./transport";

export function playProgram() { mixer.wake(); program.toggle(); }
export function shuttleProgram(dir: 1 | -1) { mixer.wake(); program.shuttle(dir); }
export const playSource = () => source.toggle();
