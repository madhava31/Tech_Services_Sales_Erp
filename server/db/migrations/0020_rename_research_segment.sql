-- The market segment "Research & Analytics" is now "Research & Academia". Renamed in place, so every
-- opportunity keeps its tag, and the companies filed under the old name follow it. A name already taken
-- is left alone. Data only: no table changes.
UPDATE market_segment SET name = 'Research & Academia', updated_at = NOW()
  WHERE name = 'Research & Analytics' AND NOT EXISTS (SELECT 1 FROM market_segment WHERE name = 'Research & Academia');
UPDATE company SET category = 'Research & Academia', updated_at = NOW()
  WHERE category = 'Research & Analytics' AND EXISTS (SELECT 1 FROM market_segment WHERE name = 'Research & Academia');
