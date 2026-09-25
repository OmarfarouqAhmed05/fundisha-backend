-- Starter skills, seeded once after schema.sql
INSERT INTO skills (name, category) VALUES
  ('JavaScript', 'coding'),
  ('Python', 'coding'),
  ('Java', 'coding'),
  ('React', 'coding'),
  ('SQL & Databases', 'coding'),
  ('Web Design', 'coding'),
  ('Spanish', 'language'),
  ('French', 'language'),
  ('Swahili', 'language'),
  ('IELTS/English Prep', 'language'),
  ('Guitar', 'music'),
  ('Piano', 'music'),
  ('Vocals', 'music'),
  ('Calculus', 'academic'),
  ('Statistics', 'academic'),
  ('Public Speaking', 'other'),
  ('Graphic Design', 'other')
ON CONFLICT (name) DO NOTHING;
