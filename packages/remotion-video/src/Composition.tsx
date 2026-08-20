import { useCurrentFrame, interpolate, Img } from 'remotion';
import type { FC } from 'react';
import type { LeaderboardData } from './data';

export const Leaderboard: FC<LeaderboardData> = ({
  title,
  subtitle,
  providers,
}) => {
  const frame = useCurrentFrame();

  const TOP = 150;
  const ROW_HEIGHT = 34;
  const NAME_X = 260;
  const BAR_X = 500;
  const BAR_MAX_WIDTH = 800;
  const SCORE_X = BAR_X + BAR_MAX_WIDTH + 32;
  const LOGO_SIZE = 28;

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        backgroundColor: '#0a0a0a',
        color: '#f5f5f5',
        fontFamily:
          "Inter, 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        position: 'relative',
      }}
    >
      <h1
        style={{
          position: 'absolute',
          left: 80,
          top: 40,
          fontSize: 56,
          margin: 0,
        }}
      >
        {title}
      </h1>
      <p
        style={{
          position: 'absolute',
          left: 80,
          top: 110,
          fontSize: 24,
          color: '#9ca3af',
          margin: 0,
        }}
      >
        {subtitle}
      </p>

      {providers.map((provider, index) => {
        const start = index * 9;
        const rowProgress = interpolate(frame, [start, start + 18], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const opacity = rowProgress;
        const translateX = (1 - rowProgress) * -40;
        const y = TOP + index * ROW_HEIGHT;

        const barProgress = interpolate(
          frame,
          [start + 8, start + 24],
          [0, provider.score],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
        const barWidth = (barProgress / 100) * BAR_MAX_WIDTH;

        return (
          <div
            key={provider.provider}
            style={{
              position: 'absolute',
              left: 80,
              top: y,
              width: 1760,
              height: ROW_HEIGHT,
              opacity,
              transform: `translateX(${translateX}px)`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: 2,
                width: 40,
                fontSize: 18,
                color: '#6b7280',
                fontWeight: 700,
              }}
            >
              {provider.rank}
            </span>

            {provider.logoUrl ? (
              <Img
                src={provider.logoUrl}
                style={{
                  position: 'absolute',
                  left: 50,
                  top: 2,
                  width: LOGO_SIZE,
                  height: LOGO_SIZE,
                  objectFit: 'contain',
                }}
              />
            ) : null}

            <span
              style={{
                position: 'absolute',
                left: NAME_X,
                top: 2,
                fontSize: 20,
                fontWeight: 600,
                width: 220,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {provider.displayName}
            </span>

            <div
              style={{
                position: 'absolute',
                left: BAR_X,
                top: 10,
                width: BAR_MAX_WIDTH,
                height: 12,
                backgroundColor: '#1f2937',
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  width: barWidth,
                  height: '100%',
                  background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                  borderRadius: 6,
                }}
              />
            </div>

            <span
              style={{
                position: 'absolute',
                left: SCORE_X,
                top: 2,
                fontSize: 20,
                fontWeight: 700,
                color: '#60a5fa',
                width: 80,
              }}
            >
              {provider.score.toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
};
