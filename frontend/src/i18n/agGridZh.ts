/**
 * Chinese localeText for AG Grid (Community).
 *
 * AG Grid has no built-in zh locale, and `localeText` is read once when the
 * grid is created — it does not react to prop changes. Pass this object only
 * while the app runs in Chinese, and give the <AgGridReact> a `key` bound to
 * the active language so a language switch rebuilds the grid with the new
 * locale.
 */
export const AG_GRID_LOCALE_ZH: Record<string, string> = {
  // Overlays
  loadingOoo: '加载中…',
  noRowsToShow: '暂无数据',

  // Filter menu
  filterOoo: '筛选…',
  searchOoo: '搜索…',
  blanks: '（空白）',
  selectAll: '（全选）',
  selectAllSearchResults: '（全选搜索结果）',
  textFilter: '文本筛选',
  numberFilter: '数字筛选',
  dateFilter: '日期筛选',
  setFilter: '集合筛选',
  dateFormatOoo: 'yyyy-mm-dd',

  // Filter conditions
  empty: '请选择',
  equals: '等于',
  notEqual: '不等于',
  contains: '包含',
  notContains: '不包含',
  startsWith: '开头是',
  endsWith: '结尾是',
  lessThan: '小于',
  greaterThan: '大于',
  lessThanOrEqual: '小于等于',
  greaterThanOrEqual: '大于等于',
  inRange: '介于',
  inRangeStart: '从',
  inRangeEnd: '至',
  blank: '为空',
  notBlank: '不为空',
  before: '早于',
  after: '晚于',
  true: '真',
  false: '假',
  andCondition: '且',
  orCondition: '或',

  // Filter actions
  applyFilter: '应用',
  resetFilter: '重置',
  clearFilter: '清除',
  cancelFilter: '取消',

  // Column menu
  columnFilter: '列筛选',
  columnChooser: '选择列',
  pinColumn: '固定列',
  noPin: '不固定',
  pinLeft: '固定在左侧',
  pinRight: '固定在右侧',
  autosizeThisColumn: '自动调整此列宽',
  autosizeAllColumns: '自动调整所有列宽',
  resetColumns: '重置列',
  sortAscending: '升序',
  sortDescending: '降序',
  sortUnSort: '取消排序',
  unSortColumn: '取消排序',

  // Pagination bar
  page: '页',
  more: '更多',
  to: '到',
  of: '共',
  firstPage: '第一页',
  previousPage: '上一页',
  nextPage: '下一页',
  lastPage: '最后一页',
  pageSizeSelectorLabel: '每页行数',
}
