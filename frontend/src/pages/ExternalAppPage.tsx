import { useState } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'

interface ExternalAppPageProps {
  /** URL of the external web app to embed. */
  url: string
  /** iframe title (accessibility). */
  title: string
  /** True while this tab is visible. */
  active?: boolean
}

/** Full-height page that embeds an external web app inside the tab. */
export default function ExternalAppPage({ url, title }: ExternalAppPageProps) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  return (
    <Box sx={{ width: '100%', height: 'calc(100vh - 56px)', position: 'relative' }}>
      <iframe
        src={url}
        title={title}
        style={{ border: 0, width: '100%', height: '100%' }}
        loading="lazy"
        allowFullScreen
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            bgcolor: 'background.default',
          }}
        >
          <CircularProgress size={36} />
          <Typography variant="body2" color="text.secondary">
            {t('tabs.loadingApp')}
          </Typography>
        </Box>
      )}
    </Box>
  )
}
