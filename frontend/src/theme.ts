import { createTheme } from '@mui/material/styles'

/**
 * Refined light theme for the ODBC query app.
 *
 * Aesthetic direction: "editorial data desk" — a warm off-white canvas, deep
 * ocean-teal primary, and a terracotta accent. Typography pairs the characterful
 * Archivo display face for headings with IBM Plex Sans for body text. Everything
 * stays light-on-light (no dark color design) with a subtle atmospheric canvas.
 */

const TEAL = '#0f6e6e'
const TERRACOTTA = '#c2542b'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: TEAL, contrastText: '#ffffff' },
    secondary: { main: TERRACOTTA, contrastText: '#ffffff' },
    success: { main: '#2f8f5b', contrastText: '#ffffff' },
    error: { main: '#c0392b', contrastText: '#ffffff' },
    warning: { main: '#b7791f', contrastText: '#ffffff' },
    info: { main: '#16728c', contrastText: '#ffffff' },
    background: { default: '#f4f6f8', paper: '#ffffff' },
    divider: '#e3e7ec',
    text: { primary: '#1a2233', secondary: '#5a6678' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: [
      '"IBM Plex Sans"',
      '"IBM Plex Sans Variable"',
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      'sans-serif',
    ].join(','),
    h4: {
      fontFamily: ['"Archivo"', '"Archivo Variable"', '"IBM Plex Sans"', 'sans-serif'].join(','),
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    h5: {
      fontFamily: ['"Archivo"', '"Archivo Variable"', '"IBM Plex Sans"', 'sans-serif'].join(','),
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    h6: {
      fontFamily: ['"Archivo"', '"Archivo Variable"', '"IBM Plex Sans"', 'sans-serif'].join(','),
      fontWeight: 600,
    },
    subtitle1: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          minHeight: 44,
          borderRadius: 8,
          // Visible keyboard focus ring (MUI's default is only a ripple).
          '&:focus-visible': { outline: `2px solid ${TEAL}`, outlineOffset: 2 },
        },
        contained: {
          '&:hover': { boxShadow: '0 4px 14px rgba(15, 110, 110, 0.28)' },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          minHeight: 48,
          minWidth: 48,
          borderRadius: 8,
          '&:focus-visible': { outline: `2px solid ${TEAL}`, outlineOffset: 2 },
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: { '&:focus-visible': { outline: `2px solid ${TEAL}`, outlineOffset: -2 } },
      },
    },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiAutocomplete: { defaultProps: { size: 'small' } },
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
      styleOverrides: { paper: { borderRadius: 12 } },
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
          '& .MuiIconButton-root': { minHeight: 36, minWidth: 36, padding: 6 },
        },
      },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 48,
          textTransform: 'none',
          fontWeight: 600,
          '&:focus-visible': { outline: `2px solid ${TEAL}`, outlineOffset: -2 },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          color: '#1a2233',
          backgroundColor: 'rgba(255, 255, 255, 0.82)',
          backgroundImage: 'none',
          backdropFilter: 'saturate(180%) blur(12px)',
          boxShadow: 'inset 0 -1px 0 #e3e7ec',
        },
      },
    },
  },
})

export default theme
