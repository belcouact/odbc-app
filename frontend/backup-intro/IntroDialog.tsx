import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import CloseIcon from '@mui/icons-material/Close'
import { useTranslation } from 'react-i18next'
import IntroAnimation from './IntroAnimation'
import { BRAND } from '../theme'

interface IntroDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Full-screen window for the app intro animation.
 *
 * The animation is now a native part of the app bundle (`IntroAnimation`),
 * not a separately served HTML file, so it renders directly here and shares
 * the app's theme. The dialog unmounts its contents when closed, so reopening
 * replays the animation from the start. Only a floating close button sits on
 * top of the animation.
 */
export default function IntroDialog({ open, onClose }: IntroDialogProps) {
  const { t } = useTranslation('intro')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      slotProps={{ paper: { sx: { borderRadius: 0, bgcolor: BRAND.paper } } }}
    >
      <IntroAnimation />
      <IconButton
        aria-label={t('intro.aria.closeIntro')}
        onClick={onClose}
        sx={{
          position: 'absolute',
          // Sit above the animation's own layers (`.ia-mark` / `.ia-stage` use
          // z-index 1), otherwise the intro paints over the button and it can't
          // be clicked.
          zIndex: 3,
          // Keep the tap target clear of the phone's status bar / safe area.
          top: { xs: 'max(env(safe-area-inset-top), 8px)', sm: 12 },
          right: { xs: 8, sm: 12 },
          color: BRAND.ink,
          bgcolor: 'rgba(255, 255, 255, 0.72)',
          border: `1px solid ${BRAND.lightGray}`,
          backdropFilter: 'blur(6px)',
          '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.95)' },
          // 48px minimum touch target on phones, where this is the only exit.
          '&&': { minWidth: { xs: 48, sm: 40 }, minHeight: { xs: 48, sm: 40 } },
        }}
      >
        <CloseIcon />
      </IconButton>
    </Dialog>
  )
}
