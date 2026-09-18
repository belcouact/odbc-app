SELECT *
FROM (
    SELECT
        g.G_WOL,
        g.G_ITEM,
        s.DESCRIPTION,
        s.G_WOL_BOR,
        g.NAME,
        g.G_ROLL_INDEX,
        g.G_FACE_BATCH,
        g.G_LINER_BATCH,
        g.G_MAN_DATE,
        ROUND(g.G_LSN_QTY,2) AS G_LSN_QTY,
        g.DESCRIPTION AS Comment,
        gm.changed_by
    FROM G_LSN g
    JOIN GM_LSN gm
        ON g.NAME = gm.G_LSN
       AND gm.GM_OPERATION = 'FMI'
    LEFT JOIN SAMPLE s
        ON g.SAMPLE_NUMBER = s.SAMPLE_NUMBER

    UNION ALL

    SELECT
        gs.G_WOL,
        gs.PRODUCT,
        gi.DESCRIPTION,
        '',
        gs.G_LSN_SAMPLE,
        gs.G_ROLL_INDEX,
        '',
        '',
        gs.G_MAN_DATE,
        ROUND(gs.G_LSN_QTY,2),
        gs.G_LIMS_SAMPLE,
        ''
    FROM GM_SAMPLES gs
    LEFT JOIN G_ITEM gi
        ON gs.PRODUCT = gi.NAME
) x
WHERE G_WOL not like 'F%'
    {}
ORDER BY G_WOL, G_ROLL_INDEX ASC