import { AbsoluteFill, getStaticFiles, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';

import { Phone } from '../Phone';
import { pop, progress, sceneOpacity } from '../anim';
import { colors, fonts } from '../theme';

const PHONE_CLIP = 'footage/phone.mp4';
const WEB_CLIP = 'footage/web.mp4';

function has(name: string) {
  return getStaticFiles().some((file) => file.name === name);
}

/**
 * Real recordings of the example app: in Chrome over Web Bluetooth (`public/footage/web.mp4`) and,
 * when it exists, on a phone (`public/footage/phone.mp4`, portrait). Without a phone recording the
 * browser fills the scene; the drawn browser screen is only a stand-in while editing.
 */
export function Footage({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const title = progress(frame, 4, 14);
  const phone = pop(frame, 10);
  const browser = pop(frame, 22);
  const withPhone = has(PHONE_CLIP);
  return (
    <AbsoluteFill style={{ opacity: sceneOpacity(frame, length) }}>
      <div
        style={{
          position: 'absolute',
          top: 60,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: fonts.sans,
          fontSize: 50,
          fontWeight: 700,
          color: colors.text,
          opacity: title,
        }}>
        The example app, on <span style={{ color: colors.accent }}>real Bluetooth</span>
      </div>
      {withPhone && (
        <div style={{ position: 'absolute', left: 170, top: 140, transform: `scale(${phone})` }}>
          <Phone scale={0.98}>
            <OffthreadVideo src={staticFile(PHONE_CLIP)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </Phone>
          <Label>iPhone · live heart rate</Label>
        </div>
      )}
      <div
        style={
          withPhone
            ? { position: 'absolute', right: 120, top: 220, transform: `scale(${browser})` }
            : { position: 'absolute', left: 0, right: 0, top: 165, display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `scale(${browser})` }
        }>
        <BrowserWindow width={withPhone ? 1020 : 1340} height={withPhone ? 680 : 798}>
          {has(WEB_CLIP) ? (
            <OffthreadVideo src={staticFile(WEB_CLIP)} muted style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
          ) : (
            <WebMock frame={frame} />
          )}
        </BrowserWindow>
        <Label>{withPhone ? 'Chrome · Web Bluetooth' : 'Chrome on a Mac, talking to an iPhone over Web Bluetooth'}</Label>
      </div>
    </AbsoluteFill>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 22,
        textAlign: 'center',
        fontFamily: fonts.sans,
        fontSize: 28,
        fontWeight: 600,
        color: colors.muted,
      }}>
      {children}
    </div>
  );
}

function BrowserWindow({ children, width, height }: { children: React.ReactNode; width: number; height: number }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        border: `1px solid ${colors.line}`,
        boxShadow: '0 40px 90px rgba(0,0,0,0.45)',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }}>
      <div
        style={{
          height: 54,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 20px',
          background: '#e9eeed',
        }}>
        {['#f87171', '#fbbf24', '#34d399'].map((dot) => (
          <div key={dot} style={{ width: 13, height: 13, borderRadius: 7, background: dot }} />
        ))}
        <div
          style={{
            marginLeft: 16,
            flex: 1,
            height: 32,
            borderRadius: 16,
            background: '#fff',
            fontFamily: fonts.sans,
            fontSize: 17,
            color: '#5b6f6c',
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 16,
          }}>
          localhost:8092 · expo-ble-kit Explorer
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>{children}</div>
    </div>
  );
}

function WebMock({ frame }: { frame: number }) {
  const picked = frame > 120;
  return (
    <div style={{ padding: 40, fontFamily: fonts.sans, position: 'relative', height: '100%' }}>
      <div style={{ fontSize: 32, fontWeight: 800, color: '#0b2a2b' }}>Nearby devices</div>
      {picked && (
        <div
          style={{
            marginTop: 26,
            padding: '20px 24px',
            borderRadius: 16,
            background: '#ccfbf1',
            fontSize: 24,
            fontWeight: 700,
            color: '#0b2a2b',
          }}>
          BleKit-Test · connected · 4 services
        </div>
      )}
      {!picked && frame > 30 && (
        <div
          style={{
            position: 'absolute',
            left: 220,
            top: 70,
            width: 560,
            padding: 26,
            borderRadius: 14,
            background: 'white',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            fontSize: 22,
            color: '#202124',
          }}>
          <div style={{ fontWeight: 600, marginBottom: 16 }}>localhost:8092 wants to pair</div>
          {['BleKit-Test', 'HRM-Pro'].map((name, index) => (
            <div
              key={name}
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: index === 0 && frame > 80 ? '#d3e3fd' : 'transparent',
              }}>
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
