import base64
import subprocess


# ============================================================
# POWERSHELL + WINFORMS POPUP
# ============================================================

POWERSHELL_POPUP = r'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()


# ============================================================
# COLORS
# ============================================================

$BackgroundColor = [System.Drawing.ColorTranslator]::FromHtml('#F4F7FB')
$CardColor       = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$PrimaryColor    = [System.Drawing.ColorTranslator]::FromHtml('#4F6BED')
$PrimaryHover    = [System.Drawing.ColorTranslator]::FromHtml('#3B55C5')
$TextColor       = [System.Drawing.ColorTranslator]::FromHtml('#253858')
$SecondaryText   = [System.Drawing.ColorTranslator]::FromHtml('#667085')
$BorderColor     = [System.Drawing.ColorTranslator]::FromHtml('#DDE3EC')
$AccentColor     = [System.Drawing.ColorTranslator]::FromHtml('#E8EEFF')
$CloseHover      = [System.Drawing.ColorTranslator]::FromHtml('#F2F4F7')


# ============================================================
# ROUNDED RECTANGLE HELPER
# ============================================================

function New-RoundedRectanglePath {

    param(
        [System.Drawing.Rectangle]$Rectangle,
        [int]$Radius
    )

    $Path = New-Object System.Drawing.Drawing2D.GraphicsPath

    $Diameter = $Radius * 2

    $Arc = New-Object System.Drawing.Rectangle(
        $Rectangle.X,
        $Rectangle.Y,
        $Diameter,
        $Diameter
    )

    $Path.AddArc($Arc, 180, 90)

    $Arc.X = $Rectangle.Right - $Diameter
    $Path.AddArc($Arc, 270, 90)

    $Arc.Y = $Rectangle.Bottom - $Diameter
    $Path.AddArc($Arc, 0, 90)

    $Arc.X = $Rectangle.X
    $Path.AddArc($Arc, 90, 90)

    $Path.CloseFigure()

    return $Path
}


# ============================================================
# MAIN WINDOW
# ============================================================

$Form = New-Object System.Windows.Forms.Form

$Form.Text = 'Break Reminder'

$Form.Size = New-Object System.Drawing.Size(
    470,
    330
)

$Form.StartPosition = 'CenterScreen'

$Form.FormBorderStyle = `
    [System.Windows.Forms.FormBorderStyle]::None

$Form.BackColor = $BackgroundColor

# Keep reminder above other windows
$Form.TopMost = $true

$Form.ShowInTaskbar = $true
$Form.KeyPreview = $true


# ============================================================
# ROUNDED WINDOW
# ============================================================

$Form.Add_Shown({

    $Rectangle = New-Object System.Drawing.Rectangle(
        0,
        0,
        $Form.Width,
        $Form.Height
    )

    $Path = New-RoundedRectanglePath `
        -Rectangle $Rectangle `
        -Radius 18

    $Form.Region = New-Object System.Drawing.Region($Path)

    $Form.Activate()
})


# ============================================================
# CARD
# ============================================================

$Card = New-Object System.Windows.Forms.Panel

$Card.Location = New-Object System.Drawing.Point(
    14,
    14
)

$Card.Size = New-Object System.Drawing.Size(
    442,
    302
)

$Card.BackColor = $CardColor


$Card.Add_Paint({

    param($Sender, $EventArgs)

    $Graphics = $EventArgs.Graphics

    $Graphics.SmoothingMode = `
        [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $Rectangle = New-Object System.Drawing.Rectangle(
        0,
        0,
        $Sender.Width - 1,
        $Sender.Height - 1
    )

    $Path = New-RoundedRectanglePath `
        -Rectangle $Rectangle `
        -Radius 15

    $Brush = New-Object System.Drawing.SolidBrush(
        $CardColor
    )

    $Pen = New-Object System.Drawing.Pen(
        $BorderColor,
        1
    )

    $Graphics.FillPath(
        $Brush,
        $Path
    )

    $Graphics.DrawPath(
        $Pen,
        $Path
    )

    $Brush.Dispose()
    $Pen.Dispose()
    $Path.Dispose()
})


$Form.Controls.Add($Card)


# ============================================================
# TOP ACCENT
# ============================================================

$Accent = New-Object System.Windows.Forms.Panel

$Accent.Location = New-Object System.Drawing.Point(
    0,
    0
)

$Accent.Size = New-Object System.Drawing.Size(
    442,
    5
)

$Accent.BackColor = $PrimaryColor

$Card.Controls.Add($Accent)


# ============================================================
# CLOSE BUTTON
# ============================================================

$CloseButton = New-Object System.Windows.Forms.Button

$CloseButton.Text = [char]0x00D7

$CloseButton.Location = New-Object System.Drawing.Point(
    393,
    12
)

$CloseButton.Size = New-Object System.Drawing.Size(
    36,
    34
)

$CloseButton.Font = New-Object System.Drawing.Font(
    'Segoe UI',
    18,
    [System.Drawing.FontStyle]::Regular
)

$CloseButton.ForeColor = $SecondaryText
$CloseButton.BackColor = $CardColor

$CloseButton.FlatStyle = `
    [System.Windows.Forms.FlatStyle]::Flat

$CloseButton.FlatAppearance.BorderSize = 0

$CloseButton.FlatAppearance.MouseOverBackColor = `
    $CloseHover

$CloseButton.Cursor = `
    [System.Windows.Forms.Cursors]::Hand


$CloseButton.Add_Click({

    $Form.Close()

})


$Card.Controls.Add($CloseButton)


# ============================================================
# ICON BACKGROUND
# ============================================================

$IconPanel = New-Object System.Windows.Forms.Panel

$IconPanel.Location = New-Object System.Drawing.Point(
    178,
    31
)

$IconPanel.Size = New-Object System.Drawing.Size(
    86,
    86
)

$IconPanel.BackColor = $CardColor


$IconPanel.Add_Paint({

    param($Sender, $EventArgs)

    $Graphics = $EventArgs.Graphics

    $Graphics.SmoothingMode = `
        [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $Brush = New-Object System.Drawing.SolidBrush(
        $AccentColor
    )

    $Graphics.FillEllipse(
        $Brush,
        4,
        4,
        $Sender.Width - 8,
        $Sender.Height - 8
    )

    $Brush.Dispose()

})


$Card.Controls.Add($IconPanel)


# ============================================================
# COFFEE ICON
# ============================================================

$IconLabel = New-Object System.Windows.Forms.Label

$IconLabel.Text = [System.Char]::ConvertFromUtf32(
    0x2615
)

$IconLabel.Location = New-Object System.Drawing.Point(
    0,
    8
)

$IconLabel.Size = New-Object System.Drawing.Size(
    86,
    65
)

$IconLabel.Font = New-Object System.Drawing.Font(
    'Segoe UI Emoji',
    34,
    [System.Drawing.FontStyle]::Regular
)

$IconLabel.TextAlign = `
    [System.Drawing.ContentAlignment]::MiddleCenter

$IconLabel.BackColor = `
    [System.Drawing.Color]::Transparent


$IconPanel.Controls.Add($IconLabel)


# ============================================================
# TITLE
# ============================================================

$TitleLabel = New-Object System.Windows.Forms.Label

$TitleLabel.Text = 'Time to take a break!'

$TitleLabel.Location = New-Object System.Drawing.Point(
    35,
    122
)

$TitleLabel.Size = New-Object System.Drawing.Size(
    372,
    38
)

$TitleLabel.Font = New-Object System.Drawing.Font(
    'Segoe UI',
    18,
    [System.Drawing.FontStyle]::Bold
)

$TitleLabel.ForeColor = $TextColor
$TitleLabel.BackColor = $CardColor

$TitleLabel.TextAlign = `
    [System.Drawing.ContentAlignment]::MiddleCenter


$Card.Controls.Add($TitleLabel)


# ============================================================
# MESSAGE
# ============================================================

$MessageLabel = New-Object System.Windows.Forms.Label

$MessageLabel.Text = `
    "You've been working hard.`r`nStand up, stretch, have some water, and rest your eyes."

$MessageLabel.Location = New-Object System.Drawing.Point(
    30,
    162
)

$MessageLabel.Size = New-Object System.Drawing.Size(
    382,
    55
)

$MessageLabel.Font = New-Object System.Drawing.Font(
    'Segoe UI',
    10,
    [System.Drawing.FontStyle]::Regular
)

$MessageLabel.ForeColor = $SecondaryText
$MessageLabel.BackColor = $CardColor

$MessageLabel.TextAlign = `
    [System.Drawing.ContentAlignment]::MiddleCenter


$Card.Controls.Add($MessageLabel)


# ============================================================
# TAKE BREAK BUTTON
# ============================================================

$BreakButton = New-Object System.Windows.Forms.Button

$CheckMark = [System.Char]::ConvertFromUtf32(
    0x2713
)

$BreakButton.Text = `
    $CheckMark + "   I'll Take a Break"

$BreakButton.Location = New-Object System.Drawing.Point(
    121,
    235
)

$BreakButton.Size = New-Object System.Drawing.Size(
    200,
    47
)

$BreakButton.Font = New-Object System.Drawing.Font(
    'Segoe UI',
    10,
    [System.Drawing.FontStyle]::Bold
)

$BreakButton.ForeColor = `
    [System.Drawing.Color]::White

$BreakButton.BackColor = $PrimaryColor

$BreakButton.FlatStyle = `
    [System.Windows.Forms.FlatStyle]::Flat

$BreakButton.FlatAppearance.BorderSize = 0

$BreakButton.FlatAppearance.MouseOverBackColor = `
    $PrimaryHover

$BreakButton.Cursor = `
    [System.Windows.Forms.Cursors]::Hand


$BreakButton.Add_Click({

    $Form.Close()

})


$Card.Controls.Add($BreakButton)

$Form.AcceptButton = $BreakButton


# ============================================================
# ESCAPE KEY
# ============================================================

$Form.Add_KeyDown({

    param($Sender, $EventArgs)

    if (
        $EventArgs.KeyCode -eq
        [System.Windows.Forms.Keys]::Escape
    ) {

        $Form.Close()

    }

})


# ============================================================
# DISPLAY
# ============================================================

[void]$Form.ShowDialog()

$Form.Dispose()
'''


# ============================================================
# LAUNCH POPUP
# ============================================================

def show_break_reminder():
    """
    Launch PowerShell WinForms as an independent child process.

    Python continues immediately without waiting for the
    popup to be closed.
    """

    encoded_script = base64.b64encode(
        POWERSHELL_POPUP.encode("utf-16-le")
    ).decode("ascii")

    command = [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-EncodedCommand",
        encoded_script
    ]

    creation_flags = 0

    if hasattr(subprocess, "CREATE_NO_WINDOW"):

        creation_flags = subprocess.CREATE_NO_WINDOW

    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags
    )


# ============================================================
# MAIN
# ============================================================

def main():

    show_break_reminder()


# ============================================================
# START
# ============================================================

if __name__ == "__main__":

    try:

        main()

    except KeyboardInterrupt:

        pass
