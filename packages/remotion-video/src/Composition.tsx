import { useCurrentFrame, interpolate, Img } from 'remotion';
import type { FC } from 'react';
import type { LeaderboardData } from './data';

const SITE_LOGO_DARK = 'https://logos.computesdk.com/api/svg/computesdk/raw/logo-dark';

export const Leaderboard: FC<LeaderboardData> = ({
  title,
  providers,
  sponsors,
}) => {
  const frame = useCurrentFrame();
  const topProviders = providers.slice(0, 5);
  const nextProviders = providers.slice(5, 10);
  const remainingOthers = Math.max(0, providers.length - 10);

  const REVEAL_START = 60; // 2s
  const REVEAL_GAP = 60; // 2s between each row fade-in
  const REVEAL_DURATION = 45; // 1.5s fade

  const TOP = 220;
  const ROW_HEIGHT = 104;
  const LOGO_WIDTH = 240;
  const LOGO_HEIGHT = 48;

  const BACKGROUND = '#030712';
  const DIVIDER = '#1f2937';
  const TEXT = '#f3f4f6';
  const MUTED = '#9ca3af';
  const RANK_BG = '#1f2937';
  const RANK_TEXT = '#6b7280';
  const BAR_BG = '#1f2937';
  const BAR_FILL = '#22c55e';
  const TICKER_BG = '#0b1120';

  const rowOpacityFor = (start: number) =>
    interpolate(frame, [start, start + REVEAL_DURATION], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  const SPONSOR_LOGO_WIDTH = 130;
  const SPONSOR_LOGO_HEIGHT = 40;
  const SPONSOR_GAP = 50;
  const TICKER_SPEED = 2;
  const sponsorItemWidth = SPONSOR_LOGO_WIDTH + SPONSOR_GAP;
  const tickerWidth = sponsors.length * sponsorItemWidth;
  const tickerOffset = (frame * TICKER_SPEED) % tickerWidth;
  const tickerRepeatCount = Math.max(2, Math.ceil(1920 / tickerWidth) + 1);

  const nextTop = TOP + 5 * ROW_HEIGHT + 48;
  const tickerTop = 1000;


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
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 40,
          width: 1760,
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h1
          style={{
            fontSize: 36,
            fontWeight: 700,
            margin: 0,
            lineHeight: 1.2,
          }}
        >
          {title}
        </h1>
        <Img
          src={SITE_LOGO_DARK}
          style={{
            width: 280,
            height: 60,
            objectFit: 'contain',
          }}
        />
      </div>

      {topProviders.map((provider) => {
        const y = TOP + (provider.rank - 1) * ROW_HEIGHT;
        const start = REVEAL_START + provider.rank * REVEAL_GAP;
        const rowOpacity = rowOpacityFor(start);
        const barWidth = (provider.score / 100) * 1760;

        return (
          <div
            key={provider.provider}
            style={{
              position: 'absolute',
              left: 0,
              top: y,
              width: 1920,
              height: ROW_HEIGHT,
              borderBottom: `1px solid ${DIVIDER}`,
              boxSizing: 'border-box',
              opacity: rowOpacity,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 80,
                top: (ROW_HEIGHT - 36) / 2,
                width: 36,
                height: 36,
                borderRadius: '50%',
                backgroundColor: RANK_BG,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
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
                  left: 136,
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
                  left: 136,
                  top: (ROW_HEIGHT - 28) / 2,
                  fontSize: 22,
                  fontWeight: 700,
                }}
              >
                {provider.displayName}
              </span>
            )}

            <div
              style={{
                position: 'absolute',
                right: 80,
                top: 20,
                textAlign: 'right',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
              }}
            >
              <span
                style={{
                  fontSize: 38,
                  fontWeight: 700,
                  color: TEXT,
                  lineHeight: 1,
                }}
              >
                {provider.score.toFixed(1)}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: MUTED,
                  marginTop: 2,
                }}
              >
                Composite Score
              </span>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 80,
                bottom: 10,
                width: 1760,
                height: 10,
                backgroundColor: BAR_BG,
                borderRadius: 5,
              }}
            >
              <div
                style={{
                  width: barWidth,
                  height: '100%',
                  backgroundColor: BAR_FILL,
                  borderRadius: 5,
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
            left: 0,
            top: nextTop,
            width: 1920,
            height: 80,
            borderTop: `1px solid ${DIVIDER}`,
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            paddingLeft: 80,
            paddingRight: 80,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: MUTED,
              flexShrink: 0,
            }}
          >
            even more
          </span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              flex: 1,
              overflow: 'hidden',
              height: 44,
            }}
          >
            {nextProviders.map((provider) =>
              provider.logoUrl ? (
                <Img
                  key={provider.provider}
                  src={provider.logoUrl}
                  style={{
                    width: 110,
                    height: 36,
                    objectFit: 'contain',
                    flexShrink: 0,
                  }}
                />
              ) : (
                <span
                  key={provider.provider}
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: TEXT,
                    flexShrink: 0,
                  }}
                >
                  {provider.displayName}
                </span>
              ),
            )}
            {remainingOthers > 0 && (
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  color: MUTED,
                  backgroundColor: RANK_BG,
                  borderRadius: 8,
                  padding: '0 12px',
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
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
            left: 0,
            top: tickerTop,
            width: 1920,
            height: 80,
            backgroundColor: TICKER_BG,
            borderTop: `1px solid ${DIVIDER}`,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 110,
              height: 80,
              backgroundColor: BAR_FILL,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 800,
              color: BACKGROUND,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              zIndex: 2,
            }}
          >
            Partners
          </div>
          <div
            style={{
              position: 'absolute',
              left: 110,
              top: 20,
              width: tickerWidth * tickerRepeatCount,
              height: SPONSOR_LOGO_HEIGHT,
              display: 'flex',
              transform: `translateX(${-tickerOffset}px)`,
              zIndex: 1,
            }}
          >
            {Array.from({ length: tickerRepeatCount })
              .flatMap((_, i) =>
                sponsors.map((sponsor) => ({ ...sponsor, run: i })),
              )
              .map((sponsor) => (
                <div
                  key={`${sponsor.name}-${sponsor.logoUrl}-${sponsor.run}`}
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
