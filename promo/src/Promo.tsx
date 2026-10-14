import { AbsoluteFill, Sequence } from 'remotion';

import { Background } from './Background';
import { CallToAction } from './scenes/CallToAction';
import { CodeDemo } from './scenes/CodeDemo';
import { Features } from './scenes/Features';
import { Footage } from './scenes/Footage';
import { Hook } from './scenes/Hook';
import { Platforms } from './scenes/Platforms';
import { Title } from './scenes/Title';

/** The scenes in order, with their lengths in frames (30 fps). */
export const SCENES = [
  { name: 'Hook', length: 165, Scene: Hook },
  { name: 'Title', length: 120, Scene: Title },
  { name: 'Code', length: 450, Scene: CodeDemo },
  { name: 'Footage', length: 330, Scene: Footage },
  { name: 'Features', length: 330, Scene: Features },
  { name: 'Platforms', length: 165, Scene: Platforms },
  { name: 'Call to action', length: 240, Scene: CallToAction },
];

export const DURATION = SCENES.reduce((total, scene) => total + scene.length, 0);

export function Promo() {
  let from = 0;
  return (
    <AbsoluteFill>
      <Background />
      {SCENES.map(({ name, length, Scene }) => {
        const start = from;
        from += length;
        return (
          <Sequence key={name} name={name} from={start} durationInFrames={length}>
            <Scene length={length} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
