import { Composition } from 'remotion';
import type { FC } from 'react';
import { Leaderboard } from './Composition';
import data from './data.json';

export const RemotionRoot = () => {
  return (
    <Composition
      id="BenchmarkLeaderboard"
      component={Leaderboard as unknown as FC<Record<string, unknown>>}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={data}
    />
  );
};
