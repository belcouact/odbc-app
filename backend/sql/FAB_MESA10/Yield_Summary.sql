WITH yield_agg AS (
    SELECT
        mys.branch_plant AS Branch_Plant,
        mys.jde_wo_number AS JDE_WO_Number,
        mys.main_group AS Main_Group,
        mys.main_group_description AS Main_Group_Description,
        mys.product_description AS Product_Description,
        mys.product AS Item,
        SUBSTR(mys.jde_wo_number, 2) AS ledger_order_number,
        SUBSTR(mys.product, 1, 7) AS product_prefix,
        MAX(mys.lam_date) AS LAM_Date,
        MAX(mys.dwr_date) AS DWR_Date,
        MAX(mys.fmi_date) AS FMI_Date,
        AVG(mys.jde_planned_yield) AS Planned_Yield,
        SUM(mys.issued_net) AS Issued_Net,
        SUM(mys.fmi_total) AS FMI_Total,
        SUM(mys.fmrs_net) + SUM(mys.pac_net) AS FMI_Good
    FROM mesa_yield_summary mys
    WHERE mys.commercial_prod = 'Commercial'
      AND mys.main_group NOT LIKE 'FXXX%'
      {}
    GROUP BY
        mys.branch_plant,
        mys.jde_wo_number,
        mys.main_group,
        mys.main_group_description,
        mys.product_description,
        mys.product,
        SUBSTR(mys.jde_wo_number, 2),
        SUBSTR(mys.product, 1, 7)
),

relevant_orders AS (
    SELECT DISTINCT
        ledger_order_number,
        product_prefix
    FROM yield_agg
),

ledger_agg AS (
    SELECT
        jil.order_number,
        SUBSTR(jil.item_number, 1, 7) AS product_prefix,
        SUM(jil.quantity * -1) AS allocated_net
    FROM jde_item_ledger jil
    INNER JOIN relevant_orders ro
        ON ro.ledger_order_number = jil.order_number
       AND ro.product_prefix = SUBSTR(jil.item_number, 1, 7)
    WHERE jil.location IN ('BATCHING', 'LINE88', 'UPS', 'RMB')
    GROUP BY
        jil.order_number,
        SUBSTR(jil.item_number, 1, 7)
),

scrap_agg AS (
    SELECT
        mss.jde_wo_number,
        SUM(mss.scrap_quantity) AS Overrun
    FROM mesa_scrap_summary mss
    INNER JOIN (
        SELECT DISTINCT jde_wo_number
        FROM yield_agg
    ) yo
        ON yo.jde_wo_number = mss.jde_wo_number
    WHERE mss.event_reason = 'P70'
    GROUP BY
        mss.jde_wo_number
)

SELECT
    ya.jde_wo_number,
    ya.main_group,
    ya.main_group_description,
    ya.product_description,
    ya.item,
    ya.lam_date,
    ya.dwr_date,
    ya.fmi_date,
    ya.planned_yield,
    COALESCE(la.allocated_net, 0) AS allocated_net,
    ya.issued_net,
    ya.fmi_total,
    ya.fmi_good,
    COALESCE(sa.overrun, 0) AS overrun
FROM yield_agg ya
LEFT JOIN ledger_agg la
    ON la.order_number = ya.ledger_order_number
   AND la.product_prefix = ya.product_prefix
LEFT JOIN scrap_agg sa
    ON sa.jde_wo_number = ya.jde_wo_number
ORDER BY
    ya.main_group_description,
    ya.jde_wo_number;