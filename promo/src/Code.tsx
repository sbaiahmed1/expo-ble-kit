import { colors, fonts } from './theme';

type Token = { text: string; color: string };

const KEYWORDS = /^(import|from|await|const|async|return|new|export)$/;

/** A small highlighter for the snippets: enough for TypeScript on screen, nothing more. */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(\/\/[^\n]*)|('[^']*'?)|(\b\d[\d_]*\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    const [text, comment, string, number, word] = match;
    let color = colors.text;
    if (comment) color = colors.comment;
    else if (string) color = colors.string;
    else if (number) color = colors.number;
    else if (word && KEYWORDS.test(word)) color = colors.keyword;
    else if (word && code[pattern.lastIndex] === '(') color = colors.fn;
    else if (word && /^[A-Z]/.test(word)) color = colors.accent;
    tokens.push({ text, color });
  }
  return tokens;
}

/** `code` typed up to `chars` characters, with a caret. */
export function TypedCode({ code, chars, fontSize = 30 }: { code: string; chars: number; fontSize?: number }) {
  let left = Math.floor(chars);
  const shown: Token[] = [];
  for (const token of tokenize(code)) {
    if (left <= 0) break;
    shown.push({ ...token, text: token.text.slice(0, left) });
    left -= token.text.length;
  }
  const done = chars >= code.length;
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: fonts.mono,
        fontSize,
        lineHeight: 1.55,
        color: colors.text,
        whiteSpace: 'pre',
      }}>
      {shown.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.text}
        </span>
      ))}
      <span
        style={{
          display: 'inline-block',
          width: fontSize * 0.55,
          height: fontSize * 1.1,
          marginLeft: 2,
          verticalAlign: 'text-bottom',
          background: colors.accent,
          opacity: done ? 0 : 0.9,
        }}
      />
    </pre>
  );
}

/** An editor window around code. */
export function Editor({ title, children, width }: { title: string; children: React.ReactNode; width: number }) {
  return (
    <div
      style={{
        width,
        borderRadius: 22,
        background: colors.surface,
        border: `1px solid ${colors.line}`,
        boxShadow: '0 40px 90px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '18px 24px',
          background: colors.surfaceHigh,
          borderBottom: `1px solid ${colors.line}`,
        }}>
        {['#f87171', '#fbbf24', '#34d399'].map((dot) => (
          <div key={dot} style={{ width: 14, height: 14, borderRadius: 7, background: dot }} />
        ))}
        <span style={{ marginLeft: 14, fontFamily: fonts.mono, fontSize: 20, color: colors.muted }}>{title}</span>
      </div>
      <div style={{ padding: '28px 34px 34px' }}>{children}</div>
    </div>
  );
}
