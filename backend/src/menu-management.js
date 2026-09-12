const CANONICAL_MENU_DELETE_TABLES = [
  "restaurant_deal_components",
  "restaurant_deals",
  "restaurant_menu_aliases",
  "restaurant_menu_variants",
  "restaurant_menu_items",
  "restaurant_menu_rules",
];

async function deleteCanonicalMenuData(client) {
  // This fixed whitelist mirrors the active menu-v2 schema. Never derive these
  // targets from request input or from a broad "menu" table-name search.
  const deleted = {};
  for (const table of CANONICAL_MENU_DELETE_TABLES) {
    const result = await client.query(`DELETE FROM ${table}`);
    deleted[table] = Number(result.rowCount || 0);
  }
  return deleted;
}

async function deleteMenuImage(client, imageId) {
  const result = await client.query(
    "DELETE FROM menu_images WHERE id = $1 RETURNING id",
    [imageId]
  );
  return result.rows[0] || null;
}

module.exports = {
  CANONICAL_MENU_DELETE_TABLES,
  deleteCanonicalMenuData,
  deleteMenuImage,
};
