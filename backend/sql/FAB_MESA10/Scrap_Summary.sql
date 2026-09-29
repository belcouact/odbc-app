SELECT
    s.MAIN_GROUP,
    s.MAIN_GROUP_DESCRIPTION,
    y.fmi_total,
    s.attributable_area,
    s.event_reason,
    s.reason_description,
    s.scrap_quantity          AS fmi_fg_scrap,
    s.scrap_quantity / NULLIF(y.fmi_total, 0) AS scrap_rate
FROM (
    SELECT
        MAIN_GROUP,
        MAIN_GROUP_DESCRIPTION,
        event_reason,
        attributable_area,
        reason_description,
        SUM(SCRAP_QUANTITY) AS scrap_quantity
    FROM mesa_scrap_summary
    WHERE MAIN_GROUP NOT LIKE 'FXXX%'
      {}
    GROUP BY
        MAIN_GROUP,
        MAIN_GROUP_DESCRIPTION,
        event_reason,
        attributable_area,
        reason_description
) s
LEFT JOIN (
    SELECT
        MAIN_GROUP,
        SUM(fmi_total) AS fmi_total
    FROM mesa_yield_summary
    WHERE MAIN_GROUP NOT LIKE 'FXXX%'
      {}
    GROUP BY MAIN_GROUP
) y
  ON y.MAIN_GROUP = s.MAIN_GROUP
ORDER BY
    s.MAIN_GROUP,
    s.scrap_quantity DESC;
