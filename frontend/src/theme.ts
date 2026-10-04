import { createTheme } from '@mui/material/styles'

/**
 * Anthropic-branded light theme for the ODBC query app.
 *
 * Aesthetic direction: the "warm study" — a cream paper canvas (#faf9f5),
 * near-black ink (#141413) for text, and a clay-orange accent (#d97757) that
 * carries every primary action. Typography uses one family throughout —
 * Lora (a humanist serif, Georgia fallback) for headings, controls and body
 * copy — and keeps IBM Plex Mono for code.
 * Secondary accents — dusty blue (#6a9bcc) and sage green (#788c5d) — are
 * used sparingly for info and success states so the palette stays calm.
 *
 * Motion is deliberately quiet: short ease-out transitions on hover/press, a
 * lift on cards, and a fade-up on view changes. Everything collapses under
 * `prefers-reduced-motion` (handled in index.css).
 */

const INK = '#141413'
const PAPER = '#faf9f5'
const CLAY = '#d97757'
const CLAY_DARK = '#b85c3e'
const CLAY_TINT = 'rgba(217, 119, 87, 0.10)'
const BLUE = '#6a9bcc'
const BLUE_DARK = '#4a7ba6'
const SAGE = '#788c5d'
const SAGE_DARK = '#44562e'
/** Bright brand green (sampled from the user's reference swatch) for success
 *  toast backgrounds — reconnection / upload / connection-test / AI-test
 *  confirmations. Dark ink text sits on it; white would fail contrast. */
const SUCCESS_GREEN = '#47d359'
/** Red for error toasts — matches the palette's error colour. */
const ERROR_RED = '#c0392b'
const MID_GRAY = '#b0aea5'
const LIGHT_GRAY = '#e8e6dc'

// One family for the whole app (headings, controls and body copy): the same
// humanist serif stack the body text uses. Georgia renders wherever the Lora
// webfont is unavailable, so every surface stays visually identical.
// Lora covers Latin only; Chinese glyphs fall through to LXGW WenKai Screen
// (Kai style, bundled above), then to whatever Kai the OS ships.
const BODY_FONT =
  '"Lora", "LXGW WenKai Screen", "Kaiti SC", STKaiti, KaiTi, "楷体", Georgia, "Times New Roman", serif'
const DISPLAY_FONT = BODY_FONT
const MONO_FONT =
  "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace"

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: CLAY, dark: CLAY_DARK, light: '#e59b7f', contrastText: '#ffffff' },
    secondary: { main: BLUE, dark: BLUE_DARK, contrastText: '#ffffff' },
    success: { main: SAGE, contrastText: '#ffffff' },
    error: { main: ERROR_RED, contrastText: '#ffffff' },
    warning: { main: '#b7791f', contrastText: '#ffffff' },
    info: { main: BLUE_DARK, contrastText: '#ffffff' },
    background: { default: PAPER, paper: '#ffffff' },
    divider: LIGHT_GRAY,
    text: { primary: INK, secondary: '#6b6a63' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: BODY_FONT,
    h1: { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.02em' },
    h2: { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.02em' },
    h3: { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.015em' },
    h4: { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.01em' },
    h5: { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontFamily: DISPLAY_FONT, fontWeight: 600, letterSpacing: '-0.005em' },
    subtitle1: { fontFamily: DISPLAY_FONT, fontWeight: 600 },
    subtitle2: { fontFamily: DISPLAY_FONT, fontWeight: 600 },
    overline: { fontFamily: DISPLAY_FONT, fontWeight: 600 },
    button: { fontFamily: DISPLAY_FONT, textTransform: 'none', fontWeight: 600 },
    caption: { fontSize: '0.78rem' },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          minHeight: 44,
          borderRadius: 10,
          transition: 'background-color .18s ease, box-shadow .18s ease, transform .12s ease',
          // Visible keyboard focus ring (MUI's default is only a ripple).
          '&:focus-visible': { outline: `2px solid ${CLAY}`, outlineOffset: 2 },
        },
        contained: {
          '&:hover': { boxShadow: '0 6px 18px rgba(217, 119, 87, 0.30)' },
          '&:active': { transform: 'translateY(1px)' },
        },
        outlined: {
          '&:hover': { backgroundColor: CLAY_TINT },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          minHeight: 48,
          minWidth: 48,
          borderRadius: 10,
          transition: 'background-color .16s ease, transform .12s ease',
          '&:focus-visible': { outline: `2px solid ${CLAY}`, outlineOffset: 2 },
          '&:active': { transform: 'scale(0.94)' },
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          transition: 'background-color .16s ease',
          '&:focus-visible': { outline: `2px solid ${CLAY}`, outlineOffset: -2 },
        },
      },
    },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiAutocomplete: { defaultProps: { size: 'small' } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#ffffff',
          '& .MuiOutlinedInput-notchedOutline': { borderColor: MID_GRAY },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: CLAY },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: CLAY,
            borderWidth: 2,
          },
        },
      },
    },
    // MUI zeroes padding-top when a DialogTitle precedes DialogContent
    // (variant selector `.MuiDialogTitle-root + &`), which clips the top
    // half of the first TextField's label. Restore breathing room.
    MuiDialogContent: {
      styleOverrides: {
        root: { paddingTop: '16px !important' },
      },
    },
    MuiDialog: {
      defaultProps: { fullWidth: true, maxWidth: 'sm' },
      styleOverrides: {
        paper: {
          borderRadius: 16,
          border: `1px solid ${LIGHT_GRAY}`,
          boxShadow: '0 24px 60px rgba(20, 20, 19, 0.18)',
        },
      },
    },
    // Compact dialog header: MUI's default vertical padding (16px on xs, 24px
    // on sm+) makes every popup's title bar feel tall. Trim it down while
    // keeping the default horizontal padding so titles stay aligned with
    // dialog content and actions.
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          paddingTop: 10,
          paddingBottom: 10,
          // Trailing close/action icon buttons must not force the header back
          // up to the global 48px min size — keep them compact inside titles.
          // Round, not the app-wide rounded square: a title-bar close should
          // read as a dismiss control, not as another toolbar button.
          '& .MuiIconButton-root': {
            minHeight: 36,
            minWidth: 36,
            padding: 6,
            borderRadius: '50%',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: { borderColor: LIGHT_GRAY },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: `1px solid ${LIGHT_GRAY}`,
          boxShadow: '0 1px 2px rgba(20, 20, 19, 0.04)',
          transition: 'box-shadow .22s ease, transform .22s ease, border-color .22s ease',
          '&:hover': {
            boxShadow: '0 10px 28px rgba(20, 20, 19, 0.10)',
            borderColor: 'rgba(217, 119, 87, 0.35)',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontFamily: DISPLAY_FONT,
          fontWeight: 600,
          borderRadius: 8,
          transition: 'background-color .16s ease, box-shadow .16s ease',
        },
      },
    },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiTab: {
      styleOverrides: {
        root: {
          fontFamily: DISPLAY_FONT,
          minHeight: 48,
          textTransform: 'none',
          fontWeight: 600,
          opacity: 0.72,
          transition: 'opacity .16s ease, background-color .16s ease',
          '&:hover': { opacity: 1 },
          '&.Mui-selected': { opacity: 1 },
          '&:focus-visible': { outline: `2px solid ${CLAY}`, outlineOffset: -2 },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          color: INK,
          backgroundColor: 'rgba(250, 249, 245, 0.86)',
          backgroundImage: 'none',
          backdropFilter: 'saturate(180%) blur(12px)',
          boxShadow: `inset 0 -1px 0 ${LIGHT_GRAY}`,
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 12, fontFamily: BODY_FONT },
      },
    },
    // Transient message bars (the Alert inside a Snackbar) share one toast
    // silhouette, but the colour follows the severity: success toasts wear
    // the bright brand green with white text (reconnection, upload,
    // connection-test / AI-test confirmations), error toasts turn red with
    // white text, everything else keeps the dark sage bar with white text.
    // Inline alerts inside forms / dialogs keep their severity colours.
    MuiSnackbar: {
      styleOverrides: {
        root: {
          '& .MuiAlert-root': {
            backgroundColor: SAGE_DARK,
            color: '#ffffff',
            border: `1px solid ${SAGE_DARK}`,
            boxShadow: '0 10px 26px rgba(20, 20, 19, 0.28)',
            paddingRight: 8,
            alignItems: 'center',
            '& .MuiAlert-icon': { color: '#ffffff', opacity: 0.95 },
            '& .MuiAlert-message': { fontWeight: 600, padding: '4px 0' },
            // Close button: a comfortable 36px round touch target, vertically
            // centred against the message instead of pinned to the top corner.
            '& .MuiAlert-action': {
              color: '#ffffff',
              alignItems: 'center',
              padding: '0 0 0 8px',
              margin: 0,
              '& .MuiIconButton-root': {
                width: 36,
                height: 36,
                padding: 0,
                borderRadius: '50%',
                color: '#ffffff',
                opacity: 0.9,
                transition: 'background-color 160ms ease, opacity 160ms ease',
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.18)', opacity: 1 },
                '&:active': { backgroundColor: 'rgba(255, 255, 255, 0.30)' },
                '& .MuiSvgIcon-root': { fontSize: 20 },
              },
            },
            // Success toasts: the bright green swatch with white text and
            // icon — the close button's hover glows white instead of dark.
            '&.MuiAlert-success': {
              backgroundColor: SUCCESS_GREEN,
              borderColor: SUCCESS_GREEN,
              color: '#ffffff',
              '& .MuiAlert-icon': { color: '#ffffff', opacity: 0.95 },
              '& .MuiAlert-action': {
                color: '#ffffff',
                '& .MuiIconButton-root': {
                  color: '#ffffff',
                  opacity: 0.9,
                  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.18)', opacity: 1 },
                  '&:active': { backgroundColor: 'rgba(255, 255, 255, 0.30)' },
                },
              },
            },
            // Error toasts: red background with white text and icon.
            '&.MuiAlert-error': {
              backgroundColor: ERROR_RED,
              borderColor: ERROR_RED,
              color: '#ffffff',
              '& .MuiAlert-icon': { color: '#ffffff', opacity: 0.95 },
              '& .MuiAlert-action': {
                color: '#ffffff',
                '& .MuiIconButton-root': {
                  color: '#ffffff',
                  opacity: 0.9,
                  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.18)', opacity: 1 },
                  '&:active': { backgroundColor: 'rgba(255, 255, 255, 0.30)' },
                },
              },
            },
          },
        },
      },
    },
    // Snackbars that pass a plain `message` render SnackbarContent instead of
    // an Alert. The app-level ones confirm successes (reconnect, self-update),
    // so they get the same bright green treatment.
    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          backgroundColor: SUCCESS_GREEN,
          color: '#ffffff',
          borderRadius: 12,
          fontFamily: BODY_FONT,
          fontWeight: 600,
          boxShadow: '0 10px 26px rgba(20, 20, 19, 0.28)',
          '& .MuiSnackbarContent-action': {
            color: '#ffffff',
            paddingLeft: 8,
            marginRight: 0,
            '& .MuiIconButton-root': {
              width: 36,
              height: 36,
              padding: 0,
              borderRadius: '50%',
              color: '#ffffff',
              opacity: 0.9,
              transition: 'background-color 160ms ease, opacity 160ms ease',
              '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.18)', opacity: 1 },
              '&:active': { backgroundColor: 'rgba(255, 255, 255, 0.30)' },
              '& .MuiSvgIcon-root': { fontSize: 20 },
            },
          },
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 999, height: 6, backgroundColor: LIGHT_GRAY },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${LIGHT_GRAY}`,
          boxShadow: '0 16px 40px rgba(20, 20, 19, 0.14)',
          borderRadius: 12,
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: { fontFamily: DISPLAY_FONT, '&:hover': { backgroundColor: CLAY_TINT } },
      },
    },
    MuiListItemAvatar: { styleOverrides: { root: { minWidth: 40 } } },
  },
})

/** Shared easing tokens for inline `sx` transitions. */
export const MOTION = {
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  fast: '0.16s',
  base: '0.24s',
}

/** Brand tokens for places that need raw values (ag-grid CSS vars, charts). */
export const BRAND = {
  ink: INK,
  paper: PAPER,
  clay: CLAY,
  clayDark: CLAY_DARK,
  clayTint: CLAY_TINT,
  blue: BLUE,
  blueDark: BLUE_DARK,
  sage: SAGE,
  midGray: MID_GRAY,
  lightGray: LIGHT_GRAY,
  displayFont: DISPLAY_FONT,
  bodyFont: BODY_FONT,
  monoFont: MONO_FONT,
}

export default theme
