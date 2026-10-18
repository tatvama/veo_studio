import { ShotsCanvas } from "../canvas/Canvas";
import { useStudio } from "./state";

/**
 * The Studio's map panel: the Shots canvas (pages/project/canvas), the same one the Shots step opens on. A shot picked on
 * it opens in the Studio's Shot panel instead of the canvas's own inspector.
 */
export default function FilmMap() {
  const s = useStudio();
  return <div className="h-full"><ShotsCanvas embedded onSelectShot={(id) => { if (id != null) s.select(id); }} /></div>;
}
