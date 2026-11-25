-- Companies added from the ERP kept the ERP's own spelling of the state ("Dadra & Nagar Haveli & Daman & Diu",
-- "Orissa", ...), which is not on the app's list of states. This writes them the way the list does. A state that is
-- not an Indian state at all is left as it is (it is not guessed at, and the health check still names it).
-- Same matching as canonicalState() in server/crm/states.js.
WITH list(name) AS (
  VALUES ('Andhra Pradesh'), ('Arunachal Pradesh'), ('Assam'), ('Bihar'), ('Chhattisgarh'), ('Goa'), ('Gujarat'), ('Haryana'),
         ('Himachal Pradesh'), ('Jharkhand'), ('Karnataka'), ('Kerala'), ('Madhya Pradesh'), ('Maharashtra'), ('Manipur'),
         ('Meghalaya'), ('Mizoram'), ('Nagaland'), ('Odisha'), ('Punjab'), ('Rajasthan'), ('Sikkim'), ('Tamil Nadu'), ('Telangana'),
         ('Tripura'), ('Uttar Pradesh'), ('Uttarakhand'), ('West Bengal'), ('Andaman and Nicobar Islands'), ('Chandigarh'),
         ('Dadra and Nagar Haveli and Daman and Diu'), ('Delhi'), ('Jammu and Kashmir'), ('Ladakh'), ('Lakshadweep'), ('Puducherry')
),
alias(key, name) AS (
  VALUES ('orissa', 'Odisha'), ('uttaranchal', 'Uttarakhand'), ('pondicherry', 'Puducherry'), ('telengana', 'Telangana'),
         ('nct of delhi', 'Delhi'), ('new delhi', 'Delhi'), ('andaman and nicobar', 'Andaman and Nicobar Islands'),
         ('andaman nicobar islands', 'Andaman and Nicobar Islands'),
         ('dadra and nagar haveli', 'Dadra and Nagar Haveli and Daman and Diu'),
         ('daman and diu', 'Dadra and Nagar Haveli and Daman and Diu'),
         ('dadra nagar haveli daman diu', 'Dadra and Nagar Haveli and Daman and Diu')
),
fix AS (
  SELECT c.id, COALESCE(l.name, a.name) AS name
    FROM company c
   CROSS JOIN LATERAL (SELECT lower(btrim(regexp_replace(regexp_replace(replace(c.state, '&', ' and '), '[.,]', ' ', 'g'), '\s+', ' ', 'g'))) AS key) k
    LEFT JOIN list l ON lower(l.name) = k.key
    LEFT JOIN alias a ON a.key = k.key
   WHERE c.state IS NOT NULL AND c.state NOT IN (SELECT name FROM list)
)
UPDATE company c SET state = f.name FROM fix f WHERE c.id = f.id AND f.name IS NOT NULL;
