import { useCurrentFrame, interpolate, Img } from 'remotion';
import type { FC } from 'react';
import type { LeaderboardData } from './data';

export const Leaderboard: FC<LeaderboardData> = ({
  title,
  subtitle,
  providers,
}) => {
  const frame = useCurrentFrame();
  const topProviders = providers.slice(0, 5);
  const minScore = topProviders[topProviders.length - 1]?.score ?? 0;

  const RACE_DURATION = 120;

  const TOP = 170;
  const ROW_HEIGHT = 130;
  const ROW_WIDTH = 1760;
  const BAR_MAX_WIDTH = 1050;
  const LOGO_WIDTH = 260;
  const LOGO_HEIGHT = 60;

  function finishFrame(score: number): number {
    const spread = Math.max(0.01, 100 - minScore);
    return Math.round(RACE_DURATION * ((100 - score) / spread));
  }

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        backgroundColor: '#0f172a',
        color: '#f3f4f6',
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
          fontSize: 64,
          fontWeight: 800,
          margin: 0,
        }}
      >
        {title}
      </h1>
      <p
        style={{
          position: 'absolute',
          left: 80,
          top: 115,
          fontSize: 24,
          color: '#94a3b8',
          margin: 0,
        }}
      >
        {subtitle}
      </p>

      {topProviders.map((provider, index) => {
        const entryProgress = interpolate(frame, [0, 15], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const opacity = entryProgress;
        const translateY = (1 - entryProgress) * 30;
        const y = TOP + index * ROW_HEIGHT;

        const end = finishFrame(provider.score);
        const barProgress = interpolate(
          frame,
          [0, end],
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
              width: ROW_WIDTH,
              height: ROW_HEIGHT - 16,
              backgroundColor: '#1e293b',
              borderRadius: 20,
              boxShadow: '0 4px 24px rgba(0, 0, 0, 0.25)',
              opacity,
              transform: `translateY(${translateY}px)`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 28,
                top: 18,
                fontSize: 48,
                fontWeight: 800,
                color: '#475569',
                width: 60,
                textAlign: 'center',
              }}
            >
              {provider.rank}
            </span>

            {provider.logoUrl ? (
              <Img
                src={provider.logoUrl}
                style={{
                  position: 'absolute',
                  left: 110,
                  top: 22,
                  width: LOGO_WIDTH,
                  height: LOGO_HEIGHT,
                  objectFit: 'contain',
                }}
              />
            ) : (
              <span
                style={{
                  position: 'absolute',
                  left: 110,
                  top: 28,
                  fontSize: 28,
                  fontWeight: 700,
                }}
              >
                {provider.displayName}
              </span>
            )}

            <span
              style={{
                position: 'absolute',
                right: 40,
                top: 14,
                fontSize: 56,
                fontWeight: 800,
                color: '#f3f4f6',
              }}
            >
              {barProgress.toFixed(1)}
            </span>

            <div
              style={{
                position: 'absolute',
                left: 110,
                bottom: 22,
                width: BAR_MAX_WIDTH,
                height: 14,
                backgroundColor: '#334155',
                borderRadius: 7,
              }}
            >
              <div
                style={{
                  width: barWidth,
                  height: '100%',
                  background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                  borderRadius: 7,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
