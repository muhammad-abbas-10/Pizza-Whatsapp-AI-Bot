-- ============================================================
-- PIZZA BAR - CANONICAL NEON MENU SCHEMA v2
-- WARNING: DESTRUCTIVE / NON-IDEMPOTENT DATA SEED.
-- This migration drops and recreates its own six canonical menu tables and
-- repopulates menu data. It is not safe to re-run after dashboard users edit
-- production prices or availability: those edits will be wiped back to the
-- seed values. Back up and review live menu data before running it manually.
-- Source: Pizza Bar menu images supplied by the restaurant/client
-- Prices are PKR and the menu states that prices include taxes.
--
-- IMPORTANT BUSINESS CONFIRMATIONS:
-- 1) "Regular" is stored exactly as "Regular". It is NOT mapped
--    to Medium because the menu does not explicitly define that.
-- 2) Drinks included in deals are selectable by the customer;
--    the menu does not specify a single brand for generic drinks.
-- 3) Pizza slots in deals may use ANY pizza from the menu unless
--    the deal/component explicitly says otherwise.
--
-- This script creates a NEW canonical schema so the old simplified
-- pizza_menu table cannot contaminate the AI with incomplete data.
-- It does not modify customer/order/session tables.
--
-- n8n should load menu context from:
--     SELECT * FROM active_restaurant_menu_for_ai ORDER BY sort_order, id;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- CLEAN ONLY OBJECTS OWNED BY THIS v2 MENU SCRIPT
-- ------------------------------------------------------------
DROP VIEW IF EXISTS active_restaurant_menu_for_ai;
DROP VIEW IF EXISTS restaurant_menu_for_ai;
DROP TABLE IF EXISTS restaurant_deal_components CASCADE;
DROP TABLE IF EXISTS restaurant_deals CASCADE;
DROP TABLE IF EXISTS restaurant_menu_aliases CASCADE;
DROP TABLE IF EXISTS restaurant_menu_variants CASCADE;
DROP TABLE IF EXISTS restaurant_menu_items CASCADE;
DROP TABLE IF EXISTS restaurant_menu_rules CASCADE;

-- ============================================================
-- 1. MENU RULES / BUSINESS FACTS
-- ============================================================
CREATE TABLE restaurant_menu_rules (
    id BIGSERIAL PRIMARY KEY,
    rule_key TEXT UNIQUE NOT NULL,
    rule_value JSONB NOT NULL,
    source_note TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO restaurant_menu_rules (rule_key, rule_value, source_note) VALUES
('pricing',
 '{"currency":"PKR","prices_include_taxes":true}'::jsonb,
 'Menu explicitly says all prices are inclusive of taxes.'),
('pizza_standard_sizes',
 '{"labels":["Small","Medium","Large","Extra Large"],"prices":{"Small":499,"Medium":999,"Large":1499,"Extra Large":2099}}'::jsonb,
 'Standard pizza price strip on menu.'),
('pizza_premium_sizes',
 '{"labels":["Medium","Large","Extra Large"],"prices":{"Medium":1249,"Large":1590,"Extra Large":2199}}'::jsonb,
 'Premium pizza price strip on menu.'),
('pizza_crust',
 '{"options":["Pan","Thin"],"thin_available_sizes":["Medium","Large"],"thin_unavailable_sizes":["Small","Extra Large"]}'::jsonb,
 'Menu explicitly says: Thin crust is only available in Medium and Large.'),
('regular_label',
 '{"label":"Regular","meaning":"exact_menu_label","equivalent_to":null}'::jsonb,
 'The menu uses Regular for some products/deals. No explicit mapping to Medium was supplied.'),
('deal_pizza_selection',
 '{"allowed":"any_active_pizza","unless_component_restricts_it":true}'::jsonb,
 'Client confirmed customers may choose any pizza from the menu for pizza slots in deals.'),
('deal_drink_selection',
 '{"generic_drinks_are_selectable":true,"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"sting_is_separately_priced_and_not_assumed":true}'::jsonb,
 'Client confirmed generic drinks in deals are not a fixed brand.'),
('lunch_deals_hours',
 '{"days":"Everyday","from":"12:00","to":"18:00","display":"12 PM to 6 PM"}'::jsonb,
 'Lunch Deals section.'),
('midnight_deals_hours',
 '{"days":"Everyday","from":"23:30","to":"04:00","display":"11:30 PM to 4:00 AM"}'::jsonb,
 'Midnight Deals section.'),
('business',
 '{"name":"Pizza Bar","phone":"0331 6 333 255","uan":"091 30 63 426","website":"www.pizzabar.com.pk","address":"Lalazar Avenue, D5, Shumali Market, (Malik Saad Market), Hayatabad Peshawar"}'::jsonb,
 'Restaurant contact information shown on menu.'),
('menu_source',
 '{"source":"Pizza Bar supplied menu images","rule":"database_values_are_authoritative"}'::jsonb,
 'AI must use Neon data as the menu source of truth.')
ON CONFLICT (rule_key) DO UPDATE SET
    rule_value = EXCLUDED.rule_value,
    source_note = EXCLUDED.source_note,
    active = TRUE,
    updated_at = NOW();

-- ============================================================
-- 2. LOGICAL MENU ITEMS
-- One row represents one named product. Variants/prices live below.
-- ============================================================
CREATE TABLE restaurant_menu_items (
    id BIGSERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    item_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_popular BOOLEAN NOT NULL DEFAULT FALSE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(category, item_type, name)
);

CREATE INDEX idx_rm_items_active ON restaurant_menu_items(active);
CREATE INDEX idx_rm_items_category ON restaurant_menu_items(category);
CREATE INDEX idx_rm_items_name ON restaurant_menu_items(name);

-- ------------------------------------------------------------
-- PIZZAS
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order,details) VALUES
('Classic Pizza','pizza','Chicken Tikka','Pizza sauce, mozzarella cheese, chicken tikka & onions',1,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Cheese Lovers','Cheesy perfection with mozzarella & parmesan on signature sauce',2,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Very Veggie','Pizza sauce, mozzarella, onions, peppers, tomatoes, olives & mushrooms',3,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Classic Pepperoni','Pizza sauce, mozzarella cheese & pepperoni',4,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','BBQ Buzz','Smoked chicken, sweet corn, onions, and black olives with smoky BBQ sauce',5,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Afghani Tikka','Afghani tikka chunks and onion on a creamy pizza sauce',6,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Chilli Chicken','Fire up your taste buds with spicy chicken chunks, onions, olives, jalapeno & hot peri sauce',7,'{"pizza_family":"standard"}'::jsonb),
('Classic Pizza','pizza','Chicken Fajita','Pizza sauce, mozzarella cheese, chicken fajita, onions & green peppers',8,'{"pizza_family":"standard"}'::jsonb),

('Signatures Pizza','pizza','Creamy Melt','Creamy sauce, mozzarella cheese, chicken chunks, onions, tomatoes & sauce drizzle',20,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Super Sicilian','Pizza sauce, mozzarella cheese, chicken chunks, onions, green peppers & jalapenos',21,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Chicken Supreme','Pizza sauce, mozzarella cheese, mix chicken, mix veggies & black olives',22,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Spicy Ranch','Creamy base topped with chicken chunks, capsicum, onions & spicy peri sauce',23,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Fajita Sicilian','Spicy chicken pizza with capsicum, onion, jalapenos, and cheese on a delicious crust',24,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Mughlai Chicken','Garlic mayo pizza with mughlai chicken, onion, mushrooms, green chilli and black olives',25,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Chicken Arabia','Savor our grilled chicken with green peppers, onions, and fresh tomatoes',26,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Behari Chicken','Behari chicken chunks with onions, green chillies, and mozzarella cheese',27,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Super Supreme','Pizza sauce, mozzarella cheese, chicken chunks, mix veggies & black olives',28,'{"pizza_family":"standard"}'::jsonb),
('Signatures Pizza','pizza','Fajita Supreme','Scrumptious pieces of chicken, fresh vegetables and lots of cheese',29,'{"pizza_family":"standard"}'::jsonb),

('Premium Pizza','pizza','Crown Crust','Grilled chicken, olives, onion, capsicum, and drizzle with special sauce',40,'{"pizza_family":"premium"}'::jsonb),
('Premium Pizza','pizza','Behari Kabab','Juicy tikka chicken & flavorful kabab with mozzarella, onions, and jalapenos, finished with signature sauce',41,'{"pizza_family":"premium"}'::jsonb),
('Premium Pizza','pizza','Pepperoni Crownza','Pepperoni, olives, drizzle with BBQ sauce',42,'{"pizza_family":"premium"}'::jsonb),
('Premium Pizza','pizza','Half N Half','Your choice: combine any 2 of our delicious pizzas',43,'{"pizza_family":"premium","choice_count":2}'::jsonb),

('Pizza Specials','pizza_special','Super Limo Pizza','3 flavours, 3 dips, 36 slices, 8 serves. Menu shows 10% off. Rs. 3399.',50,'{"flavours":3,"dips":3,"slices":36,"serves":8,"discount_text":"10% off"}'::jsonb)
;

-- ------------------------------------------------------------
-- SAUCES
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order) VALUES
('Sauces','sauce','Peri Peri Sauce','Peri peri sauce',100),
('Sauces','sauce','BBQ Sauce','BBQ sauce',101),
('Sauces','sauce','Garlic Mayo','Garlic mayo sauce',102);

-- ------------------------------------------------------------
-- APPETIZERS
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order,details) VALUES
('Appetizers','appetizer','Flaming Wings','Tender chicken wings, marinated in our peri sauce, served with chilli garlic mayo dip',110,'{"included":"chilli garlic mayo dip"}'::jsonb),
('Appetizers','appetizer','Chicken Wings','Oven bake, hot, and spicy chicken wings that tantalize your taste buds',112,'{}'::jsonb),
('Appetizers','appetizer','Hot Wings','Our signature oven baked hot & crispy wings',114,'{}'::jsonb),
('Appetizers','appetizer','Cheese Sticks','Freshly baked bread filled with the yummiest cheese blend to satisfy your cravings',116,'{}'::jsonb),
('Appetizers','appetizer','Fries','Crispy and golden fries',117,'{}'::jsonb),
('Appetizers','appetizer','Calzone Chunks','4 pcs stuffed calzone chunks served with sauce & fries',119,'{"included":["sauce","fries"],"pieces":4}'::jsonb),
('Appetizers','appetizer','Behari Chicken Rolls','Behari chicken chunks, sweet corn, and jalapenos rolled in a light tortilla',120,'{}'::jsonb),
('Appetizers','appetizer','Arabic Chicken Rolls','Spicy chicken breast, cheddar cheese & onions wrapped in a crispy tortilla',121,'{}'::jsonb),
('Appetizers','appetizer','Nuggets','Chicken nuggets',122,'{}'::jsonb),
('Appetizers','appetizer','Pizza Fries','Fries, fajita chicken, jalapeno, mozzarella cheese, cheddar cheese, spring onion drizzle on a special mayo sauce base',124,'{}'::jsonb),
('Appetizers','appetizer','Loaded Fries','Our loaded fries, where crispy golden fries meet a decadent blend of toppings',126,'{}'::jsonb),
('Appetizers','appetizer','Starter Platters','6 pcs wings, 4 pcs mini rolls, 1 regular fries & 2 dip sauces',127,'{"included":["6 pcs wings","4 pcs mini rolls","1 regular fries","2 dip sauces"]}'::jsonb);

-- ------------------------------------------------------------
-- SANDWICHES
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order) VALUES
('Sandwiches','sandwich','Mexican Sandwich','A delicious blend of spicy tender chicken, garlic mayo, lettuce, jalapeno & mozzarella cheese',200),
('Sandwiches','sandwich','Euro Sandwich','A delicious blend of mild tender chicken, garlic mayo, lettuce, pineapple & mozzarella cheese',201),
('Sandwiches','sandwich','Pizza Stacker','A unique blend of delicious sauce, crisp chicken and pizza crust',202);

-- ------------------------------------------------------------
-- BURGERS
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order) VALUES
('Burgers','burger','Zinger Burger','Our hero - crispy zinger fillet, signature mayo and lettuce - sandwiched between a sesame seed bun',210),
('Burgers','burger','Patty Burger','Perfectly fried chicken patty with fresh lettuce and sauce in a sesame seed bun',211),
('Burgers','burger','Jalapeno Burger','Patty topped with jalapenos, corns and a slice of melted Swiss cheese, covered in signature sauce and fresh vegetables on sesame bun',212),
('Burgers','burger','Zinger Supreme','Double zinger fillet with spicy & plain mayo, lettuce, cheese, on a sesame bun',213);

-- ------------------------------------------------------------
-- FRIED CHICKEN
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order,details) VALUES
('Fried Chicken','fried_chicken','Chicken Piece','Fried chicken',300,'{}'::jsonb),
('Fried Chicken','fried_chicken','Chicken Strips','Chicken strips',302,'{}'::jsonb),
('Fried Chicken','fried_chicken','Chicken N Chips','2 pieces of Hot and Crispy Fried Chicken + Fries + soft bun + signature sauce',304,'{"included":["2 pieces hot and crispy fried chicken","fries","soft bun","signature sauce"]}'::jsonb),
('Fried Chicken','fried_chicken','Crispy Box','2 pcs Hot & Crispy Chicken + 1 Regular fries + 1 Regular drink + 1 Dip sauce',305,'{"included":["2 pcs hot & crispy chicken","1 regular fries","1 regular drink","1 dip sauce"]}'::jsonb),
('Fried Chicken','fried_chicken','Strips Chips & Dips','4 Boneless Strips, Regular Fries, 2 Dips and a Drink',306,'{"included":["4 boneless strips","regular fries","2 dips","1 drink"]}'::jsonb),
('Fried Chicken','fried_chicken','Twister Wrap','Tender boneless strips, black pepper mayo, diced tomatoes and lettuce - wrapped in a tortilla',307,'{}'::jsonb);

-- ------------------------------------------------------------
-- PASTA
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order) VALUES
('Pasta','pasta','Alfredo Pasta','Pasta made in the yummiest white sauce with chicken chunks topped with cheese',400),
('Pasta','pasta','Crispy Pasta','Yummiest macaroni pasta in white sauce topped with crispy chicken and cheese',402);

-- ------------------------------------------------------------
-- DRINKS
-- ------------------------------------------------------------
INSERT INTO restaurant_menu_items(category,item_type,name,description,sort_order,details) VALUES
('Drinks','drink','7UP','Soft drink',500,'{}'::jsonb),
('Drinks','drink','Pepsi','Soft drink',501,'{}'::jsonb),
('Drinks','drink','Mountain Dew','Soft drink',502,'{}'::jsonb),
('Drinks','drink','Sting','Energy drink. Menu displays Rs.99 / Rs.150 without a size label.',503,'{"menu_price_text":"Rs.99 / 150","size_not_specified_on_menu":true}'::jsonb),
('Drinks','drink','Mirinda','Soft drink',504,'{}'::jsonb);

-- ============================================================
-- 3. MENU VARIANTS / PRICES
-- ============================================================
CREATE TABLE restaurant_menu_variants (
    id BIGSERIAL PRIMARY KEY,
    menu_item_id BIGINT NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
    variant_label TEXT,
    price INTEGER NOT NULL,
    quantity NUMERIC,
    unit TEXT,
    price_text TEXT,
    selectable BOOLEAN NOT NULL DEFAULT TRUE,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(menu_item_id, variant_label, price)
);

CREATE INDEX idx_rm_variants_item ON restaurant_menu_variants(menu_item_id);
CREATE INDEX idx_rm_variants_active ON restaurant_menu_variants(active);

-- Standard pizza prices.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT id,v.label,v.price,1,'pizza','Rs. '||v.price,
       jsonb_build_object('serves',v.serves,'crust_options',CASE WHEN v.label IN ('Medium','Large') THEN jsonb_build_array('Pan','Thin') ELSE jsonb_build_array('Pan') END),
       v.ord
FROM restaurant_menu_items i
CROSS JOIN (VALUES
    ('Small',499,'1',1),('Medium',999,'2-3',2),('Large',1499,'3-4',3),('Extra Large',2099,'4-5',4)
) AS v(label,price,serves,ord)
WHERE i.item_type='pizza'
  AND i.details->>'pizza_family'='standard';

-- Premium pizza prices.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT id,v.label,v.price,1,'pizza','Rs. '||v.price,
       jsonb_build_object('serves',v.serves,'crust_options',jsonb_build_array('Pan','Thin')),
       v.ord
FROM restaurant_menu_items i
CROSS JOIN (VALUES
    ('Medium',1249,'2-3',1),('Large',1590,'3-4',2),('Extra Large',2199,'4-5',3)
) AS v(label,price,serves,ord)
WHERE i.item_type='pizza'
  AND i.details->>'pizza_family'='premium';

-- Super Limo.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT id,'Super Limo',3399,1,'pizza','Rs. 3399',details,1
FROM restaurant_menu_items WHERE name='Super Limo Pizza';

-- Sauces: Rs.69 each.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,69,1,'sauce','Rs. 69',1
FROM restaurant_menu_items WHERE item_type='sauce';

-- Appetizers.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'6 pcs',499,6,'pcs','Rs. 499',1 FROM restaurant_menu_items WHERE name='Flaming Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'12 pcs',830,12,'pcs','Rs. 830',2 FROM restaurant_menu_items WHERE name='Flaming Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'6 pcs',440,6,'pcs','Rs. 440',1 FROM restaurant_menu_items WHERE name='Chicken Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'12 pcs',799,12,'pcs','Rs. 799',2 FROM restaurant_menu_items WHERE name='Chicken Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'6 pcs',470,6,'pcs','Rs. 470',1 FROM restaurant_menu_items WHERE name='Hot Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'12 pcs',840,12,'pcs','Rs. 840',2 FROM restaurant_menu_items WHERE name='Hot Wings';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,499,1,'serving','Rs. 499',1 FROM restaurant_menu_items WHERE name='Cheese Sticks';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Regular',220,1,'serving','Rs. 220',1 FROM restaurant_menu_items WHERE name='Fries';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Large',330,1,'serving','Rs. 330',2 FROM restaurant_menu_items WHERE name='Fries';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'4 pcs',999,4,'pcs','Rs. 999',1 FROM restaurant_menu_items WHERE name='Calzone Chunks';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,499,1,'serving','Rs. 499',1 FROM restaurant_menu_items WHERE name='Behari Chicken Rolls';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,499,1,'serving','Rs. 499',1 FROM restaurant_menu_items WHERE name='Arabic Chicken Rolls';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'4 pcs',369,4,'pcs','Rs. 369',1 FROM restaurant_menu_items WHERE name='Nuggets';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'6 pcs',449,6,'pcs','Rs. 449',2 FROM restaurant_menu_items WHERE name='Nuggets';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Regular',599,1,'serving','Rs. 599',1 FROM restaurant_menu_items WHERE name='Pizza Fries';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Large',890,1,'serving','Rs. 890',2 FROM restaurant_menu_items WHERE name='Pizza Fries';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Large',499,1,'serving','Rs. 499',1 FROM restaurant_menu_items WHERE name='Loaded Fries';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,999,1,'platter','Rs. 999',1 FROM restaurant_menu_items WHERE name='Starter Platters';

-- Sandwiches.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,649,1,'sandwich','Rs. 649',1 FROM restaurant_menu_items WHERE name='Mexican Sandwich';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,649,1,'sandwich','Rs. 649',1 FROM restaurant_menu_items WHERE name='Euro Sandwich';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,999,1,'sandwich','Rs. 999',1 FROM restaurant_menu_items WHERE name='Pizza Stacker';

-- Burgers.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,449,1,'burger','Rs. 449',1 FROM restaurant_menu_items WHERE name='Zinger Burger';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,330,1,'burger','Rs. 330',1 FROM restaurant_menu_items WHERE name='Patty Burger';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,499,1,'burger','Rs. 499',1 FROM restaurant_menu_items WHERE name='Jalapeno Burger';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,699,1,'burger','Rs. 699',1 FROM restaurant_menu_items WHERE name='Zinger Supreme';

-- Fried chicken.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'1 pc',249,1,'pc','Rs. 249',1 FROM restaurant_menu_items WHERE name='Chicken Piece';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'3 pcs',699,3,'pcs','Rs. 699',2 FROM restaurant_menu_items WHERE name='Chicken Piece';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'4 pcs',440,4,'pcs','Rs. 440',1 FROM restaurant_menu_items WHERE name='Chicken Strips';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'6 pcs',620,6,'pcs','Rs. 620',2 FROM restaurant_menu_items WHERE name='Chicken Strips';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,599,1,'meal','Rs. 599',1 FROM restaurant_menu_items WHERE name='Chicken N Chips';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,699,1,'box','Rs. 699',1 FROM restaurant_menu_items WHERE name='Crispy Box';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,720,1,'meal','Rs. 720',1 FROM restaurant_menu_items WHERE name='Strips Chips & Dips';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,NULL,440,1,'wrap','Rs. 440',1 FROM restaurant_menu_items WHERE name='Twister Wrap';

-- Pasta.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Regular',449,1,'serving','Rs. 449',1 FROM restaurant_menu_items WHERE name='Alfredo Pasta';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Large',890,1,'serving','Rs. 890',2 FROM restaurant_menu_items WHERE name='Alfredo Pasta';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Large',890,1,'serving','Rs. 890',1 FROM restaurant_menu_items WHERE name='Crispy Pasta';

-- Drinks: generic soft drink sizes are brand-selectable.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT i.id,v.label, v.price,1,'drink','Rs. '||v.price,
       jsonb_build_object('brand_selectable',true,'category_size',v.label),v.ord
FROM restaurant_menu_items i
CROSS JOIN (VALUES
    ('345ml',99,1),('1L',199,2),('1.5L',249,3),('Jumbo',299,4)
) v(label,price,ord)
WHERE i.name IN ('7UP','Pepsi','Mountain Dew','Mirinda');

-- Sting: exact menu text retained; no invented size mapping.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT id,'Menu price option 1',99,1,'drink','Rs. 99',
       '{"size_not_specified_on_menu":true}'::jsonb,1
FROM restaurant_menu_items WHERE name='Sting';
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,details,sort_order)
SELECT id,'Menu price option 2',150,1,'drink','Rs. 150',
       '{"size_not_specified_on_menu":true}'::jsonb,2
FROM restaurant_menu_items WHERE name='Sting';

-- Can: all four shown soft-drink brands, Rs.120.
INSERT INTO restaurant_menu_variants(menu_item_id,variant_label,price,quantity,unit,price_text,sort_order)
SELECT id,'Can',120,1,'can','Rs. 120',5
FROM restaurant_menu_items WHERE name IN ('7UP','Pepsi','Mountain Dew','Mirinda');

-- ============================================================
-- 4. ALIASES
-- ============================================================
CREATE TABLE restaurant_menu_aliases (
    id BIGSERIAL PRIMARY KEY,
    menu_item_id BIGINT NOT NULL REFERENCES restaurant_menu_items(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    UNIQUE(menu_item_id, alias)
);
CREATE INDEX idx_rm_aliases_alias ON restaurant_menu_aliases(alias);

INSERT INTO restaurant_menu_aliases(menu_item_id,alias)
SELECT id, lower(name) FROM restaurant_menu_items;

INSERT INTO restaurant_menu_aliases(menu_item_id,alias)
SELECT id, x.alias
FROM restaurant_menu_items i
CROSS JOIN LATERAL (VALUES
    ('chicken tikka pizza'),('tikka pizza')
) x(alias)
WHERE i.name='Chicken Tikka'
UNION ALL SELECT id,'cheese lovers pizza' FROM restaurant_menu_items WHERE name='Cheese Lovers'
UNION ALL SELECT id,'cheese pizza' FROM restaurant_menu_items WHERE name='Cheese Lovers'
UNION ALL SELECT id,'very veggie pizza' FROM restaurant_menu_items WHERE name='Very Veggie'
UNION ALL SELECT id,'veggie pizza' FROM restaurant_menu_items WHERE name='Very Veggie'
UNION ALL SELECT id,'vegetarian pizza' FROM restaurant_menu_items WHERE name='Very Veggie'
UNION ALL SELECT id,'classic pepperoni pizza' FROM restaurant_menu_items WHERE name='Classic Pepperoni'
UNION ALL SELECT id,'pepperoni pizza' FROM restaurant_menu_items WHERE name='Classic Pepperoni'
UNION ALL SELECT id,'bbq buzz pizza' FROM restaurant_menu_items WHERE name='BBQ Buzz'
UNION ALL SELECT id,'bbq pizza' FROM restaurant_menu_items WHERE name='BBQ Buzz'
UNION ALL SELECT id,'afghani tikka pizza' FROM restaurant_menu_items WHERE name='Afghani Tikka'
UNION ALL SELECT id,'afghani pizza' FROM restaurant_menu_items WHERE name='Afghani Tikka'
UNION ALL SELECT id,'chilli chicken pizza' FROM restaurant_menu_items WHERE name='Chilli Chicken'
UNION ALL SELECT id,'chili chicken pizza' FROM restaurant_menu_items WHERE name='Chilli Chicken'
UNION ALL SELECT id,'spicy chicken pizza' FROM restaurant_menu_items WHERE name='Chilli Chicken'
UNION ALL SELECT id,'chicken fajita pizza' FROM restaurant_menu_items WHERE name='Chicken Fajita'
UNION ALL SELECT id,'fajita pizza' FROM restaurant_menu_items WHERE name='Chicken Fajita'
UNION ALL SELECT id,'creamy melt pizza' FROM restaurant_menu_items WHERE name='Creamy Melt'
UNION ALL SELECT id,'super sicilian pizza' FROM restaurant_menu_items WHERE name='Super Sicilian'
UNION ALL SELECT id,'chicken supreme pizza' FROM restaurant_menu_items WHERE name='Chicken Supreme'
UNION ALL SELECT id,'spicy ranch pizza' FROM restaurant_menu_items WHERE name='Spicy Ranch'
UNION ALL SELECT id,'fajita sicilian pizza' FROM restaurant_menu_items WHERE name='Fajita Sicilian'
UNION ALL SELECT id,'mughlai chicken pizza' FROM restaurant_menu_items WHERE name='Mughlai Chicken'
UNION ALL SELECT id,'mughlai pizza' FROM restaurant_menu_items WHERE name='Mughlai Chicken'
UNION ALL SELECT id,'chicken arabia pizza' FROM restaurant_menu_items WHERE name='Chicken Arabia'
UNION ALL SELECT id,'behari chicken pizza' FROM restaurant_menu_items WHERE name='Behari Chicken'
UNION ALL SELECT id,'behari pizza' FROM restaurant_menu_items WHERE name='Behari Chicken'
UNION ALL SELECT id,'super supreme pizza' FROM restaurant_menu_items WHERE name='Super Supreme'
UNION ALL SELECT id,'fajita supreme pizza' FROM restaurant_menu_items WHERE name='Fajita Supreme'
UNION ALL SELECT id,'crown crust' FROM restaurant_menu_items WHERE name='Crown Crust'
UNION ALL SELECT id,'crown crust pizza' FROM restaurant_menu_items WHERE name='Crown Crust'
UNION ALL SELECT id,'behari kabab' FROM restaurant_menu_items WHERE name='Behari Kabab'
UNION ALL SELECT id,'behari kabab pizza' FROM restaurant_menu_items WHERE name='Behari Kabab'
UNION ALL SELECT id,'behari kebab pizza' FROM restaurant_menu_items WHERE name='Behari Kabab'
UNION ALL SELECT id,'pepperoni crownza pizza' FROM restaurant_menu_items WHERE name='Pepperoni Crownza'
UNION ALL SELECT id,'crownza' FROM restaurant_menu_items WHERE name='Pepperoni Crownza'
UNION ALL SELECT id,'half n half pizza' FROM restaurant_menu_items WHERE name='Half N Half'
UNION ALL SELECT id,'half and half pizza' FROM restaurant_menu_items WHERE name='Half N Half'
UNION ALL SELECT id,'half half pizza' FROM restaurant_menu_items WHERE name='Half N Half'
UNION ALL SELECT id,'limo pizza' FROM restaurant_menu_items WHERE name='Super Limo Pizza'
UNION ALL SELECT id,'super limo' FROM restaurant_menu_items WHERE name='Super Limo Pizza'
UNION ALL SELECT id,'peri peri' FROM restaurant_menu_items WHERE name='Peri Peri Sauce'
UNION ALL SELECT id,'peri sauce' FROM restaurant_menu_items WHERE name='Peri Peri Sauce'
UNION ALL SELECT id,'bbq' FROM restaurant_menu_items WHERE name='BBQ Sauce'
UNION ALL SELECT id,'mayo' FROM restaurant_menu_items WHERE name='Garlic Mayo'
UNION ALL SELECT id,'hot wing' FROM restaurant_menu_items WHERE name='Hot Wings'
UNION ALL SELECT id,'hot chicken wings' FROM restaurant_menu_items WHERE name='Hot Wings'
UNION ALL SELECT id,'crispy hot wings' FROM restaurant_menu_items WHERE name='Hot Wings'
UNION ALL SELECT id,'flaming wings' FROM restaurant_menu_items WHERE name='Flaming Wings'
UNION ALL SELECT id,'chicken wings' FROM restaurant_menu_items WHERE name='Chicken Wings'
UNION ALL SELECT id,'nuggets' FROM restaurant_menu_items WHERE name='Nuggets'
UNION ALL SELECT id,'chicken nuggets' FROM restaurant_menu_items WHERE name='Nuggets'
UNION ALL SELECT id,'regular fries' FROM restaurant_menu_items WHERE name='Fries'
UNION ALL SELECT id,'large fries' FROM restaurant_menu_items WHERE name='Fries'
UNION ALL SELECT id,'calzone' FROM restaurant_menu_items WHERE name='Calzone Chunks'
UNION ALL SELECT id,'behari rolls' FROM restaurant_menu_items WHERE name='Behari Chicken Rolls'
UNION ALL SELECT id,'arabic rolls' FROM restaurant_menu_items WHERE name='Arabic Chicken Rolls'
UNION ALL SELECT id,'pizza fries' FROM restaurant_menu_items WHERE name='Pizza Fries'
UNION ALL SELECT id,'loaded fries' FROM restaurant_menu_items WHERE name='Loaded Fries'
UNION ALL SELECT id,'starter platter' FROM restaurant_menu_items WHERE name='Starter Platters'
UNION ALL SELECT id,'starter platters' FROM restaurant_menu_items WHERE name='Starter Platters'
UNION ALL SELECT id,'zinger' FROM restaurant_menu_items WHERE name='Zinger Burger'
UNION ALL SELECT id,'jalapeno burger' FROM restaurant_menu_items WHERE name='Jalapeno Burger'
UNION ALL SELECT id,'zinger supreme' FROM restaurant_menu_items WHERE name='Zinger Supreme'
UNION ALL SELECT id,'twister' FROM restaurant_menu_items WHERE name='Twister Wrap'
UNION ALL SELECT id,'macaroni pasta' FROM restaurant_menu_items WHERE name='Crispy Pasta'
UNION ALL SELECT id,'sting drink' FROM restaurant_menu_items WHERE name='Sting'
ON CONFLICT (menu_item_id, alias) DO NOTHING;

-- ============================================================
-- 5. DEALS / COMBOS
-- Deals have their own price and exact component list.
-- ============================================================
CREATE TABLE restaurant_deals (
    id BIGSERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    price INTEGER NOT NULL,
    unit TEXT NOT NULL DEFAULT 'deal',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_popular BOOLEAN NOT NULL DEFAULT FALSE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    availability JSONB NOT NULL DEFAULT '{}'::jsonb,
    selection_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    sort_order INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rm_deals_active ON restaurant_deals(active);
CREATE INDEX idx_rm_deals_category ON restaurant_deals(category);
CREATE INDEX idx_rm_deals_name ON restaurant_deals(name);

INSERT INTO restaurant_deals(category,name,description,price,availability,selection_rules,sort_order,details) VALUES
('Burger Deals','Zinger Combo 1','1 Zinger + 1 Fries + 1 Pepsi',649,'{}'::jsonb,'{"drink_brand_fixed":"Pepsi"}'::jsonb,220,'{}'::jsonb),
('Burger Deals','Zinger Combo 2','2 Zinger + 2 Fries + 2 Pepsi',1249,'{}'::jsonb,'{"drink_brand_fixed":"Pepsi"}'::jsonb,221,'{}'::jsonb),
('Burger Deals','Zinger Combo 3','3 Zinger + 3 Fries + 1 Ltr Pepsi',1799,'{}'::jsonb,'{"drink_brand_fixed":"Pepsi"}'::jsonb,222,'{}'::jsonb),
('Burger Deals','Zinger Combo 4','4 Zinger + 4 Fries + 1 Ltr Pepsi',2099,'{}'::jsonb,'{"drink_brand_fixed":"Pepsi"}'::jsonb,223,'{}'::jsonb),

('Pizza Deals','2 Small Pizzas','2 Small Pizzas',920,'{}'::jsonb,'{"pizza_selection":"any_active_pizza"}'::jsonb,600,'{"pizza_size_label":"Small","pizza_count":2}'::jsonb),
('Pizza Deals','2 Regular Pizzas','2 Regular Pizzas',1849,'{}'::jsonb,'{"pizza_selection":"any_active_pizza"}'::jsonb,601,'{"pizza_size_label":"Regular","pizza_count":2}'::jsonb),
('Pizza Deals','2 Large Pizzas','2 Large Pizzas',2749,'{}'::jsonb,'{"pizza_selection":"any_active_pizza"}'::jsonb,602,'{"pizza_size_label":"Large","pizza_count":2}'::jsonb),

('Value Deals','My Box Combo-1','1 Small Pizza + 4 pcs Wings + Dip + 345ml Drink',839,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"345ml"}'::jsonb,610,'{}'::jsonb),
('Value Deals','Twin Box Combo-2','1 Medium Pizza + 6 Wings + Dip + 2 x 345ml Drinks',1449,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"345ml"}'::jsonb,611,'{}'::jsonb),
('Value Deals','Family Box Combo-3','1 Large Pizza + 8 pcs Wings + 2 Dips + 1 Liter Drink',1890,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1L"}'::jsonb,612,'{}'::jsonb),
('Value Deals','Party Box Combo-4','1 Large Pizza + 1 Medium Pizza + 12 pcs Wings + 2 Dips + 1.5 Liter Drink',2999,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1.5L"}'::jsonb,613,'{}'::jsonb),
('Value Deals','Super Box Combo-5','2 Large Pizza + 12 Pcs Wings + 2 Dip + 1.5 Litre Drink',3779,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1.5L"}'::jsonb,614,'{}'::jsonb),

('Value Deals','Value Deal-1','1 Small Pizza + 2 Pcs Garlic Bread + 1 Reg Drink + 1 Mayo Dip',1140,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,620,'{}'::jsonb),
('Value Deals','Value Deal-2','1 Medium Pizza + 2 Pcs Garlic Bread + 2 Reg Drink + 1 Mayo Dip',1249,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,621,'{}'::jsonb),
('Value Deals','Value Deal-3','1 Large Pizza + 4 Pcs Garlic Bread + 1 Ltr Drink + 1 Mayo Dip',1749,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1L"}'::jsonb,622,'{}'::jsonb),
('Value Deals','Value Deal-4','1 Large Pizza + 1 Medium Pizza + 6 Pcs Garlic Bread + 1.5 Ltr Drink + 1 Mayo Dip',2749,'{}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1.5L"}'::jsonb,623,'{}'::jsonb),

('Lunch Deals','Lunch Deal-1','1 Small Pizza + 1 Regular Drink',549,'{"days":"Everyday","from":"12:00","to":"18:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,700,'{}'::jsonb),
('Lunch Deals','Lunch Deal-2','1 Medium Pizza + 2 Regular Drinks',1099,'{"days":"Everyday","from":"12:00","to":"18:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,701,'{}'::jsonb),
('Lunch Deals','Lunch Deal-3','1 Large Pizza + 1L Drink',1549,'{"days":"Everyday","from":"12:00","to":"18:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1L"}'::jsonb,702,'{}'::jsonb),

('Midnight Deals','Midnight Deal-1','1 Small Pizza + 1 Regular Drink',549,'{"days":"Everyday","from":"23:30","to":"04:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,710,'{}'::jsonb),
('Midnight Deals','Midnight Deal-2','1 Medium Pizza + 2 Regular Drinks',1099,'{"days":"Everyday","from":"23:30","to":"04:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size_label":"Regular"}'::jsonb,711,'{}'::jsonb),
('Midnight Deals','Midnight Deal-3','1 Large Pizza + 1L Drink',1549,'{"days":"Everyday","from":"23:30","to":"04:00"}'::jsonb,'{"pizza_selection":"any_active_pizza","drink_selection":"brand_selectable","drink_size":"1L"}'::jsonb,712,'{}'::jsonb);

-- ------------------------------------------------------------
-- Deal components: exact structure, not just free-text.
-- component_type: pizza, wings, dip, drink, fries, garlic_bread,
--                 zinger, etc.
-- selectable = customer must/ may choose a concrete menu item.
-- ------------------------------------------------------------
CREATE TABLE restaurant_deal_components (
    id BIGSERIAL PRIMARY KEY,
    deal_id BIGINT NOT NULL REFERENCES restaurant_deals(id) ON DELETE CASCADE,
    component_order INTEGER NOT NULL,
    component_type TEXT NOT NULL,
    quantity NUMERIC NOT NULL,
    unit TEXT NOT NULL,
    size_label TEXT,
    component_label TEXT NOT NULL,
    selectable BOOLEAN NOT NULL DEFAULT FALSE,
    selection_group TEXT,
    allowed_item_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_rm_deal_components_deal ON restaurant_deal_components(deal_id,component_order);

-- Burger combos.
INSERT INTO restaurant_deal_components(deal_id,component_order,component_type,quantity,unit,component_label,selectable,allowed_item_rule)
SELECT id,1,'burger',1,'burger','Zinger',FALSE,'{"fixed_item":"Zinger Burger"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 1'
UNION ALL SELECT id,2,'fries',1,'serving','Fries',FALSE,'{"fixed_label":"Fries"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 1'
UNION ALL SELECT id,3,'drink',1,'drink','Pepsi',FALSE,'{"fixed_item":"Pepsi","size_label":"menu_regular_unspecified"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 1'
UNION ALL SELECT id,1,'burger',2,'burgers','Zinger',FALSE,'{"fixed_item":"Zinger Burger"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 2'
UNION ALL SELECT id,2,'fries',2,'servings','Fries',FALSE,'{"fixed_label":"Fries"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 2'
UNION ALL SELECT id,3,'drink',2,'drinks','Pepsi',FALSE,'{"fixed_item":"Pepsi","size_label":"menu_regular_unspecified"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 2'
UNION ALL SELECT id,1,'burger',3,'burgers','Zinger',FALSE,'{"fixed_item":"Zinger Burger"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 3'
UNION ALL SELECT id,2,'fries',3,'servings','Fries',FALSE,'{"fixed_label":"Fries"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 3'
UNION ALL SELECT id,3,'drink',1,'drink','Pepsi',FALSE,'{"fixed_item":"Pepsi","size_label":"1L"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 3'
UNION ALL SELECT id,1,'burger',4,'burgers','Zinger',FALSE,'{"fixed_item":"Zinger Burger"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 4'
UNION ALL SELECT id,2,'fries',4,'servings','Fries',FALSE,'{"fixed_label":"Fries"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 4'
UNION ALL SELECT id,3,'drink',1,'drink','Pepsi',FALSE,'{"fixed_item":"Pepsi","size_label":"1L"}'::jsonb FROM restaurant_deals WHERE name='Zinger Combo 4';

-- Pairs deals: any pizza can be selected, with the exact size label shown.
INSERT INTO restaurant_deal_components(deal_id,component_order,component_type,quantity,unit,size_label,component_label,selectable,selection_group,allowed_item_rule)
SELECT id,1,'pizza',2,'pizzas','Small','Small Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Small"}'::jsonb FROM restaurant_deals WHERE name='2 Small Pizzas'
UNION ALL SELECT id,1,'pizza',2,'pizzas','Regular','Regular Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Regular"}'::jsonb FROM restaurant_deals WHERE name='2 Regular Pizzas'
UNION ALL SELECT id,1,'pizza',2,'pizzas','Large','Large Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='2 Large Pizzas';

-- Value boxes.
INSERT INTO restaurant_deal_components(deal_id,component_order,component_type,quantity,unit,size_label,component_label,selectable,selection_group,allowed_item_rule)
SELECT id,1,'pizza',1,'pizza','Small','Small Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Small"}'::jsonb FROM restaurant_deals WHERE name='My Box Combo-1'
UNION ALL SELECT id,2,'wings',4,'pcs',NULL,'Wings',TRUE,'wing_selection','{"allowed":"active_wing_items"}'::jsonb FROM restaurant_deals WHERE name='My Box Combo-1'
UNION ALL SELECT id,3,'dip',1,'dip',NULL,'Dip',TRUE,'dip_selection','{"allowed":"active_sauces"}'::jsonb FROM restaurant_deals WHERE name='My Box Combo-1'
UNION ALL SELECT id,4,'drink',1,'drink','345ml','345ml Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"345ml"}'::jsonb FROM restaurant_deals WHERE name='My Box Combo-1'

UNION ALL SELECT id,1,'pizza',1,'pizza','Medium','Medium Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Medium"}'::jsonb FROM restaurant_deals WHERE name='Twin Box Combo-2'
UNION ALL SELECT id,2,'wings',6,'pcs',NULL,'Wings',TRUE,'wing_selection','{"allowed":"active_wing_items"}'::jsonb FROM restaurant_deals WHERE name='Twin Box Combo-2'
UNION ALL SELECT id,3,'dip',1,'dip',NULL,'Dip',TRUE,'dip_selection','{"allowed":"active_sauces"}'::jsonb FROM restaurant_deals WHERE name='Twin Box Combo-2'
UNION ALL SELECT id,4,'drink',2,'drinks','345ml','345ml Drinks',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"345ml"}'::jsonb FROM restaurant_deals WHERE name='Twin Box Combo-2'

UNION ALL SELECT id,1,'pizza',1,'pizza','Large','Large Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='Family Box Combo-3'
UNION ALL SELECT id,2,'wings',8,'pcs',NULL,'Wings',TRUE,'wing_selection','{"allowed":"active_wing_items"}'::jsonb FROM restaurant_deals WHERE name='Family Box Combo-3'
UNION ALL SELECT id,3,'dip',2,'dips',NULL,'Dips',TRUE,'dip_selection','{"allowed":"active_sauces"}'::jsonb FROM restaurant_deals WHERE name='Family Box Combo-3'
UNION ALL SELECT id,4,'drink',1,'drink','1L','1 Liter Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1L"}'::jsonb FROM restaurant_deals WHERE name='Family Box Combo-3'

UNION ALL SELECT id,1,'pizza',1,'pizza','Large','Large Pizza',TRUE,'pizza_selection_1','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='Party Box Combo-4'
UNION ALL SELECT id,2,'pizza',1,'pizza','Medium','Medium Pizza',TRUE,'pizza_selection_2','{"allowed":"any_active_pizza","size_label":"Medium"}'::jsonb FROM restaurant_deals WHERE name='Party Box Combo-4'
UNION ALL SELECT id,3,'wings',12,'pcs',NULL,'Wings',TRUE,'wing_selection','{"allowed":"active_wing_items"}'::jsonb FROM restaurant_deals WHERE name='Party Box Combo-4'
UNION ALL SELECT id,4,'dip',2,'dips',NULL,'Dips',TRUE,'dip_selection','{"allowed":"active_sauces"}'::jsonb FROM restaurant_deals WHERE name='Party Box Combo-4'
UNION ALL SELECT id,5,'drink',1,'drink','1.5L','1.5 Liter Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1.5L"}'::jsonb FROM restaurant_deals WHERE name='Party Box Combo-4'

UNION ALL SELECT id,1,'pizza',2,'pizzas','Large','Large Pizzas',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='Super Box Combo-5'
UNION ALL SELECT id,2,'wings',12,'pcs',NULL,'Wings',TRUE,'wing_selection','{"allowed":"active_wing_items"}'::jsonb FROM restaurant_deals WHERE name='Super Box Combo-5'
UNION ALL SELECT id,3,'dip',2,'dips',NULL,'Dips',TRUE,'dip_selection','{"allowed":"active_sauces"}'::jsonb FROM restaurant_deals WHERE name='Super Box Combo-5'
UNION ALL SELECT id,4,'drink',1,'drink','1.5L','1.5 Litre Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1.5L"}'::jsonb FROM restaurant_deals WHERE name='Super Box Combo-5';

-- Value Deal 1-4.
INSERT INTO restaurant_deal_components(deal_id,component_order,component_type,quantity,unit,size_label,component_label,selectable,selection_group,allowed_item_rule)
SELECT id,1,'pizza',1,'pizza','Small','Small Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Small"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-1'
UNION ALL SELECT id,2,'garlic_bread',2,'pcs',NULL,'Garlic Bread',FALSE,NULL,'{"menu_text":"2 pcs garlic bread"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-1'
UNION ALL SELECT id,3,'drink',1,'drink','Regular','Regular Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size_label":"Regular"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-1'
UNION ALL SELECT id,4,'dip',1,'dip',NULL,'Mayo Dip',FALSE,NULL,'{"menu_text":"1 mayo dip"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-1'

UNION ALL SELECT id,1,'pizza',1,'pizza','Medium','Medium Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Medium"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-2'
UNION ALL SELECT id,2,'garlic_bread',2,'pcs',NULL,'Garlic Bread',FALSE,NULL,'{"menu_text":"2 pcs garlic bread"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-2'
UNION ALL SELECT id,3,'drink',2,'drinks','Regular','Regular Drinks',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size_label":"Regular"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-2'
UNION ALL SELECT id,4,'dip',1,'dip',NULL,'Mayo Dip',FALSE,NULL,'{"menu_text":"1 mayo dip"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-2'

UNION ALL SELECT id,1,'pizza',1,'pizza','Large','Large Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-3'
UNION ALL SELECT id,2,'garlic_bread',4,'pcs',NULL,'Garlic Bread',FALSE,NULL,'{"menu_text":"4 pcs garlic bread"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-3'
UNION ALL SELECT id,3,'drink',1,'drink','1L','1 Ltr Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1L"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-3'
UNION ALL SELECT id,4,'dip',1,'dip',NULL,'Mayo Dip',FALSE,NULL,'{"menu_text":"1 mayo dip"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-3'

UNION ALL SELECT id,1,'pizza',1,'pizza','Large','Large Pizza',TRUE,'pizza_selection_1','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-4'
UNION ALL SELECT id,2,'pizza',1,'pizza','Medium','Medium Pizza',TRUE,'pizza_selection_2','{"allowed":"any_active_pizza","size_label":"Medium"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-4'
UNION ALL SELECT id,3,'garlic_bread',6,'pcs',NULL,'Garlic Bread',FALSE,NULL,'{"menu_text":"6 pcs garlic bread"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-4'
UNION ALL SELECT id,4,'drink',1,'drink','1.5L','1.5 Ltr Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1.5L"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-4'
UNION ALL SELECT id,5,'dip',1,'dip',NULL,'Mayo Dip',FALSE,NULL,'{"menu_text":"1 mayo dip"}'::jsonb FROM restaurant_deals WHERE name='Value Deal-4';

-- Lunch + Midnight deals.
INSERT INTO restaurant_deal_components(deal_id,component_order,component_type,quantity,unit,size_label,component_label,selectable,selection_group,allowed_item_rule)
SELECT id,1,'pizza',1,'pizza','Small','Small Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Small"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-1','Midnight Deal-1')
UNION ALL SELECT id,2,'drink',1,'drink','Regular','Regular Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size_label":"Regular"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-1','Midnight Deal-1')
UNION ALL SELECT id,1,'pizza',1,'pizza','Medium','Medium Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Medium"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-2','Midnight Deal-2')
UNION ALL SELECT id,2,'drink',2,'drinks','Regular','Regular Drinks',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size_label":"Regular"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-2','Midnight Deal-2')
UNION ALL SELECT id,1,'pizza',1,'pizza','Large','Large Pizza',TRUE,'pizza_selection','{"allowed":"any_active_pizza","size_label":"Large"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-3','Midnight Deal-3')
UNION ALL SELECT id,2,'drink',1,'drink','1L','1L Drink',TRUE,'drink_selection','{"allowed_brands":["7UP","Pepsi","Mountain Dew","Mirinda"],"size":"1L"}'::jsonb FROM restaurant_deals WHERE name IN ('Lunch Deal-3','Midnight Deal-3');

-- ============================================================
-- 6. DEAL ALIASES
-- ============================================================
-- Deals use their own aliases in the AI view; no fake menu-item FK is created.

-- ============================================================
-- 7. AI VIEW
-- One row per normal menu variant + one row per deal.
-- Deal rows include exact structured components and selection rules.
-- ============================================================
CREATE VIEW restaurant_menu_for_ai AS
SELECT
    i.id,
    'menu_item'::TEXT AS record_type,
    i.category,
    i.item_type,
    i.name,
    i.description,
    v.id AS variant_id,
    v.variant_label AS size_or_variant,
    v.price,
    v.quantity,
    v.unit,
    COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.alias)
              FROM restaurant_menu_aliases a WHERE a.menu_item_id=i.id),'[]'::jsonb) AS aliases,
    v.details AS variant_details,
    i.details AS item_details,
    NULL::jsonb AS deal_components,
    NULL::jsonb AS deal_availability,
    NULL::jsonb AS deal_selection_rules,
    i.is_popular,
    i.is_featured,
    i.sort_order
FROM restaurant_menu_items i
JOIN restaurant_menu_variants v ON v.menu_item_id=i.id AND v.active=TRUE
WHERE i.active=TRUE

UNION ALL

SELECT
    d.id,
    'deal'::TEXT AS record_type,
    d.category,
    'deal'::TEXT AS item_type,
    d.name,
    d.description,
    NULL::BIGINT AS variant_id,
    NULL::TEXT AS size_or_variant,
    d.price,
    NULL::NUMERIC AS quantity,
    d.unit,
    CASE d.name
      WHEN 'Zinger Combo 1' THEN '["zinger combo 1","combo 1"]'::jsonb
      WHEN 'Zinger Combo 2' THEN '["zinger combo 2","combo 2"]'::jsonb
      WHEN 'Zinger Combo 3' THEN '["zinger combo 3","combo 3"]'::jsonb
      WHEN 'Zinger Combo 4' THEN '["zinger combo 4","combo 4"]'::jsonb
      WHEN '2 Small Pizzas' THEN '["2 small pizzas","two small pizzas","small pizza pair"]'::jsonb
      WHEN '2 Regular Pizzas' THEN '["2 regular pizzas","two regular pizzas","regular pizza pair"]'::jsonb
      WHEN '2 Large Pizzas' THEN '["2 large pizzas","two large pizzas","large pizza pair"]'::jsonb
      WHEN 'My Box Combo-1' THEN '["my box combo 1","my box"]'::jsonb
      WHEN 'Twin Box Combo-2' THEN '["twin box combo 2","twin box"]'::jsonb
      WHEN 'Family Box Combo-3' THEN '["family box combo 3","family box"]'::jsonb
      WHEN 'Party Box Combo-4' THEN '["party box combo 4","party box"]'::jsonb
      WHEN 'Super Box Combo-5' THEN '["super box combo 5","super box"]'::jsonb
      WHEN 'Value Deal-1' THEN '["value deal 1"]'::jsonb
      WHEN 'Value Deal-2' THEN '["value deal 2"]'::jsonb
      WHEN 'Value Deal-3' THEN '["value deal 3"]'::jsonb
      WHEN 'Value Deal-4' THEN '["value deal 4"]'::jsonb
      WHEN 'Lunch Deal-1' THEN '["lunch deal 1","lunch 1"]'::jsonb
      WHEN 'Lunch Deal-2' THEN '["lunch deal 2","lunch 2"]'::jsonb
      WHEN 'Lunch Deal-3' THEN '["lunch deal 3","lunch 3"]'::jsonb
      WHEN 'Midnight Deal-1' THEN '["midnight deal 1","midnight 1"]'::jsonb
      WHEN 'Midnight Deal-2' THEN '["midnight deal 2","midnight 2"]'::jsonb
      WHEN 'Midnight Deal-3' THEN '["midnight deal 3","midnight 3"]'::jsonb
      ELSE '[]'::jsonb
    END AS aliases,
    d.details AS variant_details,
    d.details AS item_details,
    (SELECT jsonb_agg(jsonb_build_object(
        'order',c.component_order,
        'type',c.component_type,
        'quantity',c.quantity,
        'unit',c.unit,
        'size_label',c.size_label,
        'label',c.component_label,
        'selectable',c.selectable,
        'selection_group',c.selection_group,
        'allowed_item_rule',c.allowed_item_rule,
        'details',c.details
      ) ORDER BY c.component_order)
      FROM restaurant_deal_components c WHERE c.deal_id=d.id) AS deal_components,
    d.availability AS deal_availability,
    d.selection_rules AS deal_selection_rules,
    d.is_popular,
    d.is_featured,
    d.sort_order
FROM restaurant_deals d
WHERE d.active=TRUE;

CREATE VIEW active_restaurant_menu_for_ai AS
SELECT
    id,
    record_type,
    category,
    item_type,
    name,
    description,
    variant_id,
    size_or_variant,
    price,
    quantity,
    unit,
    aliases,
    variant_details,
    item_details,
    deal_components,
    deal_availability,
    deal_selection_rules,
    is_popular,
    is_featured,
    sort_order,
    CONCAT_WS(' | ',
        'RECORD_TYPE='||record_type,
        'CATEGORY='||category,
        'TYPE='||item_type,
        'NAME='||name,
        CASE WHEN description IS NOT NULL THEN 'DESCRIPTION='||description END,
        CASE WHEN size_or_variant IS NOT NULL THEN 'VARIANT='||size_or_variant END,
        CASE WHEN price IS NOT NULL THEN 'PRICE_PKR='||price::TEXT END,
        CASE WHEN quantity IS NOT NULL THEN 'QUANTITY='||quantity::TEXT END,
        CASE WHEN unit IS NOT NULL THEN 'UNIT='||unit END,
        CASE WHEN aliases IS NOT NULL AND aliases <> '[]'::jsonb THEN 'ALIASES='||aliases::TEXT END,
        CASE WHEN variant_details IS NOT NULL AND variant_details <> '{}'::jsonb THEN 'VARIANT_DETAILS='||variant_details::TEXT END,
        CASE WHEN item_details IS NOT NULL AND item_details <> '{}'::jsonb THEN 'ITEM_DETAILS='||item_details::TEXT END,
        CASE WHEN deal_components IS NOT NULL THEN 'DEAL_COMPONENTS='||deal_components::TEXT END,
        CASE WHEN deal_availability IS NOT NULL AND deal_availability <> '{}'::jsonb THEN 'AVAILABILITY='||deal_availability::TEXT END,
        CASE WHEN deal_selection_rules IS NOT NULL AND deal_selection_rules <> '{}'::jsonb THEN 'SELECTION_RULES='||deal_selection_rules::TEXT END,
        CASE WHEN is_popular THEN 'POPULAR=TRUE' END,
        CASE WHEN is_featured THEN 'FEATURED=TRUE' END
    ) AS ai_text
FROM restaurant_menu_for_ai;

-- ============================================================
-- 8. VALIDATION QUERIES (COMMENTED; run after import)
-- ============================================================
-- SELECT * FROM active_restaurant_menu_for_ai
-- WHERE lower(name) LIKE '%party box combo-4%';
--
-- SELECT * FROM active_restaurant_menu_for_ai
-- WHERE lower(name) LIKE '%hot wings%'
-- ORDER BY size_or_variant;
--
-- SELECT name, price, deal_components, deal_selection_rules
-- FROM active_restaurant_menu_for_ai
-- WHERE record_type='deal'
-- ORDER BY sort_order;
--
-- SELECT name, size_or_variant, price
-- FROM active_restaurant_menu_for_ai
-- WHERE category='Sauces'
-- ORDER BY name;

COMMIT;
