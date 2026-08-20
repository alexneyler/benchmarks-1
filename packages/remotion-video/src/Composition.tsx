import { useCurrentFrame, interpolate, Img } from 'remotion';
import type { FC } from 'react';
import type { LeaderboardData } from './data';

export const Leaderboard: FC<LeaderboardData> = ({
  title,
  subtitle,
  providers,
  sponsors,
}) => {
  const frame = useCurrentFrame();
  const topProviders = providers.slice(0, 5);
  const nextProviders = providers.slice(5, 10);
  const remainingOthers = Math.max(0, providers.length - 10);
  const minScore = topProviders[topProviders.length - 1]?.score ?? 0;

  const RACE_DURATION = 480;

  const TOP = 190;
  const ROW_HEIGHT = 108;
  const ROW_WIDTH = 1760;
  const CARD_GAP = 16;
  const LOGO_WIDTH = 220;
  const LOGO_HEIGHT = 44;

  const BACKGROUND = '#030712';
  const CARD_BG = '#0f172a';
  const CARD_BORDER = '#1f2937';
  const TEXT = '#f3f4f6';
  const MUTED = '#9ca3af';
  const RANK_BG = '#1f2937';
  const RANK_TEXT = '#6b7280';
  const BAR_BG = '#1f2937';
  const BAR_FILL = '#3b82f6';

  function finishFrame(score: number): number {
    const spread = Math.max(0.01, 100 - minScore);
    return Math.max(1, Math.round(RACE_DURATION * ((100 - score) / spread)));
  }

  const otherProgress = interpolate(frame, [RACE_DURATION, RACE_DURATION + 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const tickerOpacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const SPONSOR_LOGO_WIDTH = 130;
  const SPONSOR_LOGO_HEIGHT = 40;
  const SPONSOR_GAP = 50;
  const TICKER_SPEED = 3;
  const sponsorItemWidth = SPONSOR_LOGO_WIDTH + SPONSOR_GAP;
  const tickerWidth = sponsors.length * sponsorItemWidth;
  const tickerOffset = (frame * TICKER_SPEED) % tickerWidth;
  const tickerRepeatCount = Math.max(2, Math.ceil(ROW_WIDTH / tickerWidth) + 1);

  const nextTop = TOP + 5 * (ROW_HEIGHT + CARD_GAP) + 24;
  const tickerTop = nextTop + 100 + 24;

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        backgroundColor: BACKGROUND,
        color: TEXT,
        fontFamily:
          "Inter, 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        position: 'relative',
      }}
    >
      <h1
        style={{
          position: 'absolute',
          left: 80,
          top: 50,
          fontSize: 56,
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
          top: 120,
          fontSize: 20,
          color: MUTED,
          margin: 0,
        }}
      >
        {subtitle}
      </p>

      {topProviders.map((provider) => {
        const entryProgress = interpolate(frame, [0, 30], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const opacity = entryProgress;
        const translateY = (1 - entryProgress) * 30;
        const y = TOP + (provider.rank - 1) * (ROW_HEIGHT + CARD_GAP);

        const end = finishFrame(provider.score);
        const barProgress = interpolate(
          frame,
          [0, end],
          [0, provider.score],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
        const barWidth = (barProgress / 100) * (ROW_WIDTH - 64);

        return (
          <div
            key={provider.provider}
            style={{
              position: 'absolute',
              left: 80,
              top: y,
              width: ROW_WIDTH,
              height: ROW_HEIGHT,
              backgroundColor: CARD_BG,
              border: `1px solid ${CARD_BORDER}`,
              borderRadius: 16,
              opacity,
              transform: `translateY(${translateY}px)`,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 20,
                top: (ROW_HEIGHT - 40) / 2,
                width: 40,
                height: 40,
                borderRadius: '50%',
                backgroundColor: RANK_BG,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 700,
                color: RANK_TEXT,
              }}
            >
              {provider.rank}
            </div>

            {provider.logoUrl ? (
              <Img
                src={provider.logoUrl}
                style={{
                  position: 'absolute',
                  left: 76,
                  top: (ROW_HEIGHT - LOGO_HEIGHT) / 2,
                  width: LOGO_WIDTH,
                  height: LOGO_HEIGHT,
                  objectFit: 'contain',
                }}
              />
            ) : (
              <span
                style={{
                  position: 'absolute',
                  left: 76,
                  top: (ROW_HEIGHT - 32) / 2,
                  fontSize: 24,
                  fontWeight: 700,
                }}
              >
                {provider.displayName}
              </span>
            )}

            <div
              style={{
                position: 'absolute',
                right: 32,
                top: (ROW_HEIGHT - 54) / 2,
                textAlign: 'right',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
              }}
            >
              <span
                style={{
                  fontSize: 42,
                  fontWeight: 700,
                  color: TEXT,
                  lineHeight: 1,
                }}
              >
                {barProgress.toFixed(1)}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: MUTED,
                  marginTop: 4,
                }}
              >
                Composite Score
              </span>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 20,
                bottom: 8,
                width: ROW_WIDTH - 40,
                height: 4,
                backgroundColor: BAR_BG,
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  width: barWidth,
                  height: '100%',
                  backgroundColor: BAR_FILL,
                  borderRadius: 2,
                }}
              />
            </div>
          </div>
        );
      })}

      {nextProviders.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 80,
            top: nextTop,
            width: ROW_WIDTH,
            height: 100,
            backgroundColor: CARD_BG,
            border: `1px solid ${CARD_BORDER}`,
            borderRadius: 16,
            opacity: otherProgress,
            transform: `translateY(${(1 - otherProgress) * 30}px)`,
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 28,
              top: 14,
              fontSize: 18,
              fontWeight: 700,
              color: MUTED,
            }}
          >
            even more
          </span>
          <div
            style={{
              position: 'absolute',
              left: 28,
              top: 44,
              right: 28,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              gap: '20px',
            }}
          >
            {nextProviders.map((provider) =>
              provider.logoUrl ? (
                <Img
                  key={provider.provider}
                  src={provider.logoUrl}
                  style={{
                    width: 120,
                    height: 40,
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <span
                  key={provider.provider}
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: TEXT,
                  }}
                >
                  {provider.displayName}
                </span>
              ),
            )}
            {remainingOthers > 0 && (
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  color: MUTED,
                  backgroundColor: RANK_BG,
                  borderRadius: 12,
                  padding: '6px 12px',
                }}
              >
                +{remainingOthers} others
              </span>
            )}
          </div>
        </div>
      )}

      {sponsors.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 80,
            top: tickerTop,
            width: ROW_WIDTH,
            height: 80,
            backgroundColor: CARD_BG,
            border: `1px solid ${CARD_BORDER}`,
            borderRadius: 16,
            opacity: tickerOpacity,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 15,
              width: tickerWidth * tickerRepeatCount,
              height: SPONSOR_LOGO_HEIGHT,
              display: 'flex',
              transform: `translateX(${-tickerOffset}px)`,
            }}
          >
            {Array.from({ length: tickerRepeatCount })
              .flatMap((_, i) =>
                sponsors.map((sponsor) => ({ ...sponsor, run: i })),
              )
              .map((sponsor) => (
                <div
                  key={`${sponsor.name}-${sponsor.run}`}
                  style={{
                    width: sponsorItemWidth,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Img
                    src={sponsor.logoUrl}
                    alt={sponsor.name}
                    style={{
                      width: SPONSOR_LOGO_WIDTH,
                      height: SPONSOR_LOGO_HEIGHT,
                      objectFit: 'contain',
                    }}
                  />
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};
