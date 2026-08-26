BEGIN;

INSERT INTO menu_categories (name, display_order) VALUES
  ('Classic Pizzas', 10),
  ('Signature Pizzas', 20),
  ('Premium Pizzas', 30),
  ('Appetizers', 40),
  ('Sandwiches', 50),
  ('Burgers', 60),
  ('Fried Chicken', 70),
  ('Pasta', 80),
  ('Drinks', 90),
  ('Value Deals', 100),
  ('Pizza Deals', 110),
  ('Lunch Deals', 120),
  ('Midnight Deals', 130),
  ('Burger Deals', 140)
ON CONFLICT (name) DO UPDATE SET
  display_order = EXCLUDED.display_order,
  active = TRUE;

WITH item_data(category_name, name, aliases, description) AS (
  VALUES
    ('Classic Pizzas', 'Chicken Tikka', ARRAY['chicken tikka pizza'], 'Pizza sauce, mozzarella cheese, chicken tikka and onions'),
    ('Classic Pizzas', 'Cheese Lovers', ARRAY['cheese lover','cheese pizza'], 'Cheesy pizza with mozzarella and parmesan on signature sauce'),
    ('Classic Pizzas', 'Very Veggie', ARRAY['veggie','vegetable pizza'], 'Pizza sauce, mozzarella, onions, peppers, tomatoes, olives and mushrooms'),
    ('Classic Pizzas', 'Classic Pepperoni', ARRAY['pepperoni'], 'Pizza sauce, mozzarella cheese and pepperoni'),
    ('Classic Pizzas', 'BBQ Buzz', ARRAY['bbq chicken pizza'], 'Smoked chicken, sweet corn, onions, black olives and smoky BBQ sauce'),
    ('Classic Pizzas', 'Afghani Tikka', ARRAY['afghani pizza'], 'Afghani tikka chunks and onion on a creamy pizza sauce'),
    ('Classic Pizzas', 'Chilli Chicken', ARRAY['chili chicken'], 'Spicy chicken chunks, onions, olives, jalapenos and hot peri sauce'),
    ('Classic Pizzas', 'Chicken Fajita', ARRAY['fajita pizza'], 'Pizza sauce, mozzarella cheese, chicken fajita, onions and green peppers'),

    ('Signature Pizzas', 'Creamy Melt', ARRAY[]::TEXT[], 'Creamy sauce, mozzarella cheese, chicken chunks, onions, tomatoes and sauce drizzle'),
    ('Signature Pizzas', 'Super Sicilian', ARRAY[]::TEXT[], 'Pizza sauce, mozzarella cheese, chicken chunks, onions, green peppers and jalapenos'),
    ('Signature Pizzas', 'Chicken Supreme', ARRAY[]::TEXT[], 'Pizza sauce, mozzarella cheese, Mexican chicken, mixed vegetables and black olives'),
    ('Signature Pizzas', 'Spicy Ranch', ARRAY[]::TEXT[], 'Creamy base topped with chicken chunks, capsicum, onions and spicy peri sauce'),
    ('Signature Pizzas', 'Fajita Sicilian', ARRAY[]::TEXT[], 'Spicy chicken pizza with capsicum, onion, jalapenos and cheese on a crust'),
    ('Signature Pizzas', 'Mughlai Chicken', ARRAY[]::TEXT[], 'Garlic mayo pizza with Mughlai chicken, onion, mushroom, green chilli and black olives'),
    ('Signature Pizzas', 'Chicken Arabia', ARRAY[]::TEXT[], 'Savory grilled chicken with green peppers, onions and fresh tomatoes'),
    ('Signature Pizzas', 'Behari Chicken', ARRAY['bihari chicken'], 'Behari chicken chunks with onions, green chillies and mozzarella cheese'),
    ('Signature Pizzas', 'Super Supreme', ARRAY[]::TEXT[], 'Pizza sauce, mozzarella cheese, chicken chunks, mixed vegetables and black olives'),
    ('Signature Pizzas', 'Fajita Supreme', ARRAY[]::TEXT[], 'Fajita chicken, fresh vegetables and cheese'),

    ('Premium Pizzas', 'Crown Crust', ARRAY[]::TEXT[], 'Grilled chicken, olives, onion, capsicum and drizzle with special sauce'),
    ('Premium Pizzas', 'Behari Kabab', ARRAY['bihari kabab'], 'Chicken and flavorful kabab with mozzarella, onions and jalapenos'),
    ('Premium Pizzas', 'Pepperoni Crownza', ARRAY['crownza'], 'Pepperoni and olives drizzled with BBQ sauce'),
    ('Premium Pizzas', 'Half N Half', ARRAY['half and half'], 'Combine any two available pizza flavours'),
    ('Premium Pizzas', 'Super Limo Pizza', ARRAY['limo pizza'], 'Three flavours, three dips, 36 slices and approximately eight servings'),

    ('Appetizers', 'Flaming Wings', ARRAY[]::TEXT[], 'Tender chicken wings served with chilli garlic mayo dip'),
    ('Appetizers', 'Chicken Wings', ARRAY[]::TEXT[], 'Oven-baked hot and spicy chicken wings'),
    ('Appetizers', 'Hot Wings', ARRAY[]::TEXT[], 'Signature oven-baked hot and crispy wings'),
    ('Appetizers', 'Cheese Sticks', ARRAY[]::TEXT[], 'Freshly baked bread filled with cheese blend'),
    ('Appetizers', 'Fries', ARRAY['french fries'], 'Crispy golden fries'),
    ('Appetizers', 'Calzone Chunks', ARRAY[]::TEXT[], 'Four stuffed calzone chunks served with sauce and fries'),
    ('Appetizers', 'Behari Chicken Rolls', ARRAY['bihari chicken rolls'], 'Behari chicken chunks, sweet corn and jalapenos in a tortilla'),
    ('Appetizers', 'Arabic Chicken Rolls', ARRAY[]::TEXT[], 'Spicy chicken breast, cheddar cheese and onions in a tortilla'),
    ('Appetizers', 'Nuggets', ARRAY['chicken nuggets'], 'Tender chicken nuggets'),
    ('Appetizers', 'Pizza Fries', ARRAY[]::TEXT[], 'Fries with fajita chicken, jalapeno, mozzarella, cheddar, spring onion and mayo sauce'),
    ('Appetizers', 'Loaded Fries', ARRAY[]::TEXT[], 'Crispy golden fries with toppings'),
    ('Appetizers', 'Starter Platters', ARRAY['starter platter'], 'Six wings, four spin rolls, regular fries and two dip sauces'),

    ('Sandwiches', 'Mexican Sandwich', ARRAY[]::TEXT[], 'Spicy tender chicken, garlic mayo, lettuce, jalapeno and mozzarella cheese'),
    ('Sandwiches', 'Euro Sandwich', ARRAY[]::TEXT[], 'Mild tender chicken, garlic mayo, lettuce, pineapple and mozzarella cheese'),
    ('Sandwiches', 'Pizza Stacker', ARRAY[]::TEXT[], 'Sauce, crisp chicken and pizza crust'),

    ('Burgers', 'Zinger Burger', ARRAY['zinger'], 'Crispy zinger fillet with mayo and lettuce'),
    ('Burgers', 'Patty Burger', ARRAY[]::TEXT[], 'Fried chicken patty with lettuce and sauce'),
    ('Burgers', 'Jalapeno Burger', ARRAY['jalapeno zinger'], 'Patty topped with jalapenos, sauce and cheese'),
    ('Burgers', 'Zinger Supreme', ARRAY[]::TEXT[], 'Double zinger fillet with spicy and plain mayo and lettuce'),

    ('Fried Chicken', 'Chicken Piece', ARRAY[]::TEXT[], 'Fried chicken pieces'),
    ('Fried Chicken', 'Chicken Strips', ARRAY[]::TEXT[], 'Fried chicken strips'),
    ('Fried Chicken', 'Chicken N Chips', ARRAY['chicken and chips'], 'Two pieces fried chicken, fries and sauce'),
    ('Fried Chicken', 'Crispy Box', ARRAY[]::TEXT[], 'Two hot and crispy chicken pieces, fries and regular drink'),
    ('Fried Chicken', 'Strips Chips & Dips', ARRAY['strips chips and dips'], 'Four boneless strips, regular fries, two dips and a drink'),
    ('Fried Chicken', 'Twister Wrap', ARRAY['twister'], 'Tender boneless strips, black pepper mayo, tomatoes and lettuce in a tortilla'),

    ('Pasta', 'Alfredo Pasta', ARRAY[]::TEXT[], 'White sauce pasta with chicken chunks and cheese'),
    ('Pasta', 'Crispy Pasta', ARRAY[]::TEXT[], 'White sauce macaroni topped with crispy chicken and cheese'),

    ('Drinks', 'Soft Drink', ARRAY['drink','pepsi','7up','mountain dew','mirinda'], 'Soft drink; brand subject to availability'),
    ('Drinks', 'Can Drink', ARRAY['can'], 'Soft drink can; brand subject to availability'),

    ('Value Deals', 'My Box Combo 1', ARRAY['combo 1','my box'], 'One small pizza, four wings, one dip and one 345ml drink'),
    ('Value Deals', 'Twin Box Combo 2', ARRAY['combo 2','twin box'], 'One medium pizza, six wings, one dip and two 345ml drinks'),
    ('Value Deals', 'Family Box Combo 3', ARRAY['combo 3','family box'], 'One large pizza, eight wings, two dips and one 1 litre drink'),
    ('Value Deals', 'Party Box Combo 4', ARRAY['combo 4','party box'], 'One large pizza, one medium pizza, twelve wings, two dips and one 1.5 litre drink'),
    ('Value Deals', 'Super Box Combo 5', ARRAY['combo 5','super box'], 'Two large pizzas, twelve wings, two dips and one 1.5 litre drink'),

    ('Pizza Deals', 'Value Deal 1', ARRAY[]::TEXT[], 'One small pizza, two garlic breads, one regular drink and one mayo dip'),
    ('Pizza Deals', 'Value Deal 2', ARRAY[]::TEXT[], 'One medium pizza, two garlic breads, two regular drinks and one mayo dip'),
    ('Pizza Deals', 'Value Deal 3', ARRAY[]::TEXT[], 'One large pizza, four garlic breads, one 1 litre drink and one mayo dip'),
    ('Pizza Deals', 'Value Deal 4', ARRAY[]::TEXT[], 'One large pizza, one medium pizza, six garlic breads, one 1.5 litre drink and one mayo dip'),
    ('Pizza Deals', 'Pairs Deal - 2 Small Pizzas', ARRAY['two small pizzas'], 'Two small pizzas'),
    ('Pizza Deals', 'Pairs Deal - 2 Regular Pizzas', ARRAY['two regular pizzas'], 'Two regular pizzas'),
    ('Pizza Deals', 'Pairs Deal - 2 Large Pizzas', ARRAY['two large pizzas'], 'Two large pizzas'),

    ('Lunch Deals', 'Lunch Deal 1', ARRAY[]::TEXT[], 'One small pizza and one regular drink; available daily 12pm to 6pm'),
    ('Lunch Deals', 'Lunch Deal 2', ARRAY[]::TEXT[], 'One medium pizza and two regular drinks; available daily 12pm to 6pm'),
    ('Lunch Deals', 'Lunch Deal 3', ARRAY[]::TEXT[], 'One large pizza and one 1 litre drink; available daily 12pm to 6pm'),
    ('Midnight Deals', 'Midnight Deal 1', ARRAY[]::TEXT[], 'One small pizza and one regular drink; available daily 11:30pm to 4am'),
    ('Midnight Deals', 'Midnight Deal 2', ARRAY[]::TEXT[], 'One medium pizza and two regular drinks; available daily 11:30pm to 4am'),
    ('Midnight Deals', 'Midnight Deal 3', ARRAY[]::TEXT[], 'One large pizza and one 1 litre drink; available daily 11:30pm to 4am'),

    ('Burger Deals', 'Zinger Combo 1', ARRAY[]::TEXT[], 'One zinger burger, one fries and one Pepsi'),
    ('Burger Deals', 'Zinger Combo 2', ARRAY[]::TEXT[], 'Two zinger burgers, two fries and two Pepsi drinks'),
    ('Burger Deals', 'Zinger Combo 3', ARRAY[]::TEXT[], 'Three zinger burgers, three fries and one 1 litre Pepsi'),
    ('Burger Deals', 'Zinger Combo 4', ARRAY[]::TEXT[], 'Four zinger burgers, four fries and one 1 litre Pepsi')
)
INSERT INTO menu_items (category_id, name, aliases, description)
SELECT c.id, d.name, d.aliases, d.description
FROM item_data d
JOIN menu_categories c ON c.name = d.category_name
ON CONFLICT (name) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  aliases = EXCLUDED.aliases,
  description = EXCLUDED.description,
  active = TRUE,
  updated_at = NOW();

WITH variant_data(item_name, size, price) AS (
  VALUES
    ('Chicken Tikka','Small',499),('Chicken Tikka','Medium',999),('Chicken Tikka','Large',1499),('Chicken Tikka','Extra Large',2099),
    ('Cheese Lovers','Small',499),('Cheese Lovers','Medium',999),('Cheese Lovers','Large',1499),('Cheese Lovers','Extra Large',2099),
    ('Very Veggie','Small',499),('Very Veggie','Medium',999),('Very Veggie','Large',1499),('Very Veggie','Extra Large',2099),
    ('Classic Pepperoni','Small',499),('Classic Pepperoni','Medium',999),('Classic Pepperoni','Large',1499),('Classic Pepperoni','Extra Large',2099),
    ('BBQ Buzz','Small',499),('BBQ Buzz','Medium',999),('BBQ Buzz','Large',1499),('BBQ Buzz','Extra Large',2099),
    ('Afghani Tikka','Small',499),('Afghani Tikka','Medium',999),('Afghani Tikka','Large',1499),('Afghani Tikka','Extra Large',2099),
    ('Chilli Chicken','Small',499),('Chilli Chicken','Medium',999),('Chilli Chicken','Large',1499),('Chilli Chicken','Extra Large',2099),
    ('Chicken Fajita','Small',499),('Chicken Fajita','Medium',999),('Chicken Fajita','Large',1499),('Chicken Fajita','Extra Large',2099),
    ('Creamy Melt','Small',499),('Creamy Melt','Medium',999),('Creamy Melt','Large',1499),('Creamy Melt','Extra Large',2099),
    ('Super Sicilian','Small',499),('Super Sicilian','Medium',999),('Super Sicilian','Large',1499),('Super Sicilian','Extra Large',2099),
    ('Chicken Supreme','Small',499),('Chicken Supreme','Medium',999),('Chicken Supreme','Large',1499),('Chicken Supreme','Extra Large',2099),
    ('Spicy Ranch','Small',499),('Spicy Ranch','Medium',999),('Spicy Ranch','Large',1499),('Spicy Ranch','Extra Large',2099),
    ('Fajita Sicilian','Small',499),('Fajita Sicilian','Medium',999),('Fajita Sicilian','Large',1499),('Fajita Sicilian','Extra Large',2099),
    ('Mughlai Chicken','Small',499),('Mughlai Chicken','Medium',999),('Mughlai Chicken','Large',1499),('Mughlai Chicken','Extra Large',2099),
    ('Chicken Arabia','Small',499),('Chicken Arabia','Medium',999),('Chicken Arabia','Large',1499),('Chicken Arabia','Extra Large',2099),
    ('Behari Chicken','Small',499),('Behari Chicken','Medium',999),('Behari Chicken','Large',1499),('Behari Chicken','Extra Large',2099),
    ('Super Supreme','Small',499),('Super Supreme','Medium',999),('Super Supreme','Large',1499),('Super Supreme','Extra Large',2099),
    ('Fajita Supreme','Small',499),('Fajita Supreme','Medium',999),('Fajita Supreme','Large',1499),('Fajita Supreme','Extra Large',2099),
    ('Crown Crust','Medium',1249),('Crown Crust','Large',1590),('Crown Crust','Extra Large',2199),
    ('Behari Kabab','Medium',1249),('Behari Kabab','Large',1590),('Behari Kabab','Extra Large',2199),
    ('Pepperoni Crownza','Medium',1249),('Pepperoni Crownza','Large',1590),('Pepperoni Crownza','Extra Large',2199),
    ('Half N Half','Medium',1249),('Half N Half','Large',1590),('Half N Half','Extra Large',2199),
    ('Super Limo Pizza','Regular',3399),

    ('Flaming Wings','6 Pieces',499),('Flaming Wings','12 Pieces',830),
    ('Chicken Wings','6 Pieces',440),('Chicken Wings','12 Pieces',799),
    ('Hot Wings','6 Pieces',470),('Hot Wings','12 Pieces',840),
    ('Cheese Sticks','Regular',499),('Fries','Regular',220),('Fries','Large',330),
    ('Calzone Chunks','4 Pieces',999),('Behari Chicken Rolls','Regular',499),('Arabic Chicken Rolls','Regular',499),
    ('Nuggets','4 Pieces',369),('Nuggets','6 Pieces',449),
    ('Pizza Fries','Regular',599),('Pizza Fries','Large',890),('Loaded Fries','Large',499),('Starter Platters','Regular',999),
    ('Mexican Sandwich','Regular',649),('Euro Sandwich','Regular',649),('Pizza Stacker','Regular',999),
    ('Zinger Burger','Regular',449),('Patty Burger','Regular',330),('Jalapeno Burger','Regular',499),('Zinger Supreme','Regular',699),
    ('Chicken Piece','1 Piece',249),('Chicken Piece','3 Pieces',699),('Chicken Strips','4 Pieces',440),('Chicken Strips','6 Pieces',620),
    ('Chicken N Chips','Regular',599),('Crispy Box','Regular',699),('Strips Chips & Dips','Regular',720),('Twister Wrap','Regular',440),
    ('Alfredo Pasta','Regular',449),('Alfredo Pasta','Large',890),('Crispy Pasta','Large',890),
    ('Soft Drink','345ml',99),('Soft Drink','1 Litre',199),('Soft Drink','1.5 Litre',249),('Soft Drink','Jumbo',299),('Can Drink','Can',120),

    ('My Box Combo 1','Deal',839),('Twin Box Combo 2','Deal',1449),('Family Box Combo 3','Deal',1890),('Party Box Combo 4','Deal',2999),('Super Box Combo 5','Deal',3779),
    ('Value Deal 1','Deal',740),('Value Deal 2','Deal',1249),('Value Deal 3','Deal',1749),('Value Deal 4','Deal',2749),
    ('Pairs Deal - 2 Small Pizzas','Deal',920),('Pairs Deal - 2 Regular Pizzas','Deal',1849),('Pairs Deal - 2 Large Pizzas','Deal',2749),
    ('Lunch Deal 1','Deal',549),('Lunch Deal 2','Deal',1099),('Lunch Deal 3','Deal',1549),
    ('Midnight Deal 1','Deal',549),('Midnight Deal 2','Deal',1099),('Midnight Deal 3','Deal',1549),
    ('Zinger Combo 1','Deal',649),('Zinger Combo 2','Deal',1249),('Zinger Combo 3','Deal',1799),('Zinger Combo 4','Deal',2099)
)
INSERT INTO menu_variants (menu_item_id, size, price)
SELECT i.id, v.size, v.price
FROM variant_data v
JOIN menu_items i ON i.name = v.item_name
ON CONFLICT (menu_item_id, size) DO UPDATE SET
  price = EXCLUDED.price,
  active = TRUE;

INSERT INTO menu_extras (name, extra_type, price) VALUES
  ('Peri Peri Sauce', 'sauce', 69),
  ('BBQ Sauce', 'sauce', 69),
  ('Garlic Mayo Sauce', 'sauce', 69)
ON CONFLICT (name) DO UPDATE SET
  extra_type = EXCLUDED.extra_type,
  price = EXCLUDED.price,
  active = TRUE;

COMMIT;
