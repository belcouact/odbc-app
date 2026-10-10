SELECT
  *
FROM
  (
    SELECT
      mesa_yield_summary.jde_wo_number,
      mesa_yield_summary.main_group,
      mesa_yield_summary.main_group_description,
      mesa_yield_summary.product_description,
      mesa_yield_summary.product ITEM,
      max(mesa_yield_summary.LAM_DATE) LAM_DATE,
      max(mesa_yield_summary.DWR_DATE) DWR_DATE,
      max(mesa_yield_summary.FMI_DATE) FMI_DATE,
      avg(mesa_yield_summary.jde_planned_yield) planned_yield,
      (
        SELECT
          sum(quantity * -1)
        FROM
          jde_item_ledger
        WHERE
          order_number = substr (mesa_yield_summary.jde_wo_number, 2)
          AND (location IN ('BATCHING', 'LINE88', 'UPS', 'RMB'))
          AND substr (item_number, 1, 7) = substr (mesa_yield_summary.product, 1, 7)
      ) allocated_net,
      sum(mesa_yield_summary.ISSUED_NET) issued_net,
      sum(mesa_yield_summary.fmi_total) fmi_total,
      (
        sum(mesa_yield_summary.fmrs_net) + sum(mesa_yield_summary.pac_net)
      ) fmi_good
    FROM
      mesa_yield_summary
    WHERE
      mesa_yield_summary.commercial_prod = 'Commercial'
      AND mesa_yield_summary.MAIN_GROUP NOT LIKE 'FXXX%'
      {}
    GROUP BY
      mesa_yield_summary.jde_wo_number,
      mesa_yield_summary.main_group,
      mesa_yield_summary.main_group_description,
      mesa_yield_summary.product_description,
      mesa_yield_summary.product
  ) yield_query
  LEFT JOIN (
    SELECT
      sum(mesa_scrap_summary.scrap_quantity) Overrun,
      mesa_scrap_summary.jde_wo_number WO
    FROM
      mesa_scrap_summary
    WHERE
      mesa_scrap_summary.event_reason = 'P70'
    GROUP BY
      mesa_scrap_summary.jde_wo_number
  ) scrap_query ON yield_query.jde_wo_number = scrap_query.WO
ORDER BY
  yield_query.main_group_description,
  yield_query.jde_wo_number