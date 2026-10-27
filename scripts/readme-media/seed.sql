-- Demo data for the README screenshots (made up).
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  vip BOOLEAN NOT NULL DEFAULT 0,
  signed_up DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  preferences JSON
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  total DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO products (name,price,stock) VALUES ('Espresso beans 1kg',24.9,82);
INSERT INTO products (name,price,stock) VALUES ('Pour-over kettle',59.0,38);
INSERT INTO products (name,price,stock) VALUES ('Ceramic mug',12.5,101);
INSERT INTO products (name,price,stock) VALUES ('Hand grinder',89.0,12);
INSERT INTO products (name,price,stock) VALUES ('Paper filters ×100',6.4,18);
INSERT INTO products (name,price,stock) VALUES ('Cold brew jar',29.9,137);
INSERT INTO products (name,price,stock) VALUES ('Milk frother',34.0,24);
INSERT INTO products (name,price,stock) VALUES ('Travel tumbler',22.0,93);
INSERT INTO products (name,price,stock) VALUES ('Oolong tea 200g',18.5,14);
INSERT INTO products (name,price,stock) VALUES ('Matcha whisk set',27.0,129);
INSERT INTO products (name,price,stock) VALUES ('Drip scale',41.0,54);
INSERT INTO products (name,price,stock) VALUES ('Moka pot',36.0,9);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Ana Silva','ana.silva@example.com','Lisbon',1,'2025-01-01 08:00:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Bao Nguyen','bao.nguyen@example.com','Hanoi',0,'2025-02-04 09:07:00','{"newsletter": false, "lang": "de"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Chloe Martin','chloe.martin@example.com','Lyon',0,'2025-03-07 10:14:00','{"newsletter": true, "lang": "de"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('David Kim','david.kim@example.com','Seoul',0,'2025-04-10 11:21:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Elif Yilmaz','elif.yilmaz@example.com','Izmir',0,'2025-05-13 12:28:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Farid Haddad','farid.haddad@example.com',NULL,1,'2025-06-16 13:35:00','{"newsletter": false, "lang": "vi"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Grace Lee','grace.lee@example.com','Toronto',0,'2025-07-19 14:42:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Hiro Tanaka','hiro.tanaka@example.com','Osaka',0,'2025-08-22 15:49:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Ines Costa','ines.costa@example.com','Porto',0,'2025-09-25 16:56:00','{"newsletter": true, "lang": "de"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Jonas Weber','jonas.weber@example.com','Berlin',0,'2025-10-01 17:03:00','{"newsletter": false, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Kim Park','kim.park@example.com','Busan',1,'2025-11-04 08:10:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Linh Tran','linh.tran@example.com','Da Nang',0,'2025-12-07 09:17:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Marco Rossi','marco.rossi@example.com',NULL,0,'2025-01-10 10:24:00','{"newsletter": true, "lang": "vi"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Nadia Ali','nadia.ali@example.com','Cairo',0,'2025-02-13 11:31:00','{"newsletter": false, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Omar Khan','omar.khan@example.com','Lahore',0,'2025-03-16 12:38:00','{"newsletter": true, "lang": "de"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Priya Patel','priya.patel@example.com','Pune',1,'2025-04-19 13:45:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Quinn Moore','quinn.moore@example.com','Austin',0,'2025-05-22 14:52:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Rosa Garcia','rosa.garcia@example.com','Madrid',0,'2025-06-25 15:59:00','{"newsletter": false, "lang": "vi"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Sven Berg','sven.berg@example.com','Oslo',0,'2025-07-01 16:06:00','{"newsletter": true, "lang": "en"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Tuan Pham','tuan.pham@example.com',NULL,0,'2025-08-04 17:13:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Uma Shah','uma.shah@example.com','Lisbon',1,'2025-09-07 08:20:00','{"newsletter": true, "lang": "vi"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Viktor Novak','viktor.novak@example.com','Hanoi',0,'2025-10-10 09:27:00','{"newsletter": false, "lang": "fr"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Wen Chen','wen.chen@example.com','Lyon',0,'2025-11-13 10:34:00','{"newsletter": true, "lang": "de"}');
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Yara Haddad','yara.haddad@example.com','Seoul',0,'2025-12-16 11:41:00',NULL);
INSERT INTO customers (name,email,city,vip,signed_up,preferences) VALUES ('Zoe Fischer','zoe.fischer@example.com','Izmir',0,'2025-01-19 12:48:00','{"newsletter": true, "lang": "vi"}');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (10,9,1,18.5,'refunded',NULL,'2026-09-01 09:00:00');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (19,11,2,82.0,'refunded','gift wrap','2026-09-02 10:13:07');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (4,11,2,82.0,'refunded',NULL,'2026-09-03 11:26:14');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (2,12,1,36.0,'refunded',NULL,'2026-09-04 12:39:21');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (18,4,4,356.0,'pending',NULL,'2026-09-05 13:52:28');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (15,6,4,119.6,'delivered',NULL,'2026-09-06 14:05:35');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (6,5,2,12.8,'shipped',NULL,'2026-09-07 15:18:42');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (16,2,3,177.0,'delivered',NULL,'2026-09-08 16:31:49');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (20,12,4,144.0,'paid',NULL,'2026-09-09 17:44:56');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (25,2,4,236.0,'delivered','leave at the door','2026-09-10 18:57:03');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (2,3,4,50.0,'paid','call before delivery','2026-09-11 19:10:10');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (23,9,3,55.5,'delivered',NULL,'2026-09-12 20:23:17');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (15,10,4,108.0,'paid',NULL,'2026-09-13 09:36:24');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (23,2,3,177.0,'paid','call before delivery','2026-09-14 10:49:31');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (19,1,3,74.7,'pending',NULL,'2026-09-15 11:02:38');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (12,5,4,25.6,'paid',NULL,'2026-09-16 12:15:45');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (20,8,3,66.0,'paid','leave at the door','2026-09-17 13:28:52');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (25,8,1,22.0,'delivered','leave at the door','2026-09-18 14:41:59');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (13,3,2,25.0,'pending','call before delivery','2026-09-19 15:54:06');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (13,2,2,118.0,'refunded','call before delivery','2026-09-20 16:07:13');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (14,5,2,12.8,'refunded',NULL,'2026-09-21 17:20:20');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (22,5,4,25.6,'pending',NULL,'2026-09-22 18:33:27');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (6,4,2,178.0,'shipped','gift wrap','2026-09-23 19:46:34');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (16,4,2,178.0,'refunded','gift wrap','2026-09-24 20:59:41');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (1,3,3,37.5,'shipped',NULL,'2026-09-25 09:12:48');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (19,7,3,102.0,'delivered',NULL,'2026-10-26 10:25:55');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (25,3,1,12.5,'refunded','call before delivery','2026-10-27 11:38:02');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (13,7,4,136.0,'paid','call before delivery','2026-10-01 12:51:09');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (7,8,4,88.0,'paid','gift wrap','2026-10-02 13:04:16');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (4,4,4,356.0,'delivered','leave at the door','2026-10-03 14:17:23');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (1,10,1,27.0,'refunded','gift wrap','2026-10-04 15:30:30');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (20,3,1,12.5,'paid',NULL,'2026-10-05 16:43:37');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (13,2,2,118.0,'shipped',NULL,'2026-10-06 17:56:44');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (20,11,3,123.0,'delivered',NULL,'2026-10-07 18:09:51');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (16,8,1,22.0,'pending','gift wrap','2026-10-08 19:22:58');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (3,8,4,88.0,'shipped',NULL,'2026-10-09 20:35:05');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (9,2,3,177.0,'pending',NULL,'2026-10-10 09:48:12');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (1,12,2,72.0,'shipped',NULL,'2026-10-11 10:01:19');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (23,9,3,55.5,'refunded','leave at the door','2026-10-12 11:14:26');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (3,1,3,74.7,'delivered',NULL,'2026-10-13 12:27:33');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (12,9,3,55.5,'shipped','leave at the door','2026-10-14 13:40:40');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (8,9,3,55.5,'refunded',NULL,'2026-10-15 14:53:47');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (13,4,2,178.0,'shipped',NULL,'2026-10-16 15:06:54');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (24,4,4,356.0,'paid',NULL,'2026-10-17 16:19:01');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (9,1,3,74.7,'shipped','call before delivery','2026-10-18 17:32:08');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (24,12,3,108.0,'delivered','call before delivery','2026-10-19 18:45:15');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (4,6,1,29.9,'shipped','leave at the door','2026-10-20 19:58:22');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (7,8,2,44.0,'pending',NULL,'2026-10-21 20:11:29');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (21,10,1,27.0,'delivered','call before delivery','2026-10-22 09:24:36');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (22,11,1,41.0,'paid',NULL,'2026-10-23 10:37:43');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (6,7,2,68.0,'pending','call before delivery','2026-11-24 11:50:50');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (24,11,3,123.0,'pending','gift wrap','2026-11-25 12:03:57');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (3,8,4,88.0,'shipped',NULL,'2026-11-26 13:16:04');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (5,3,2,25.0,'refunded','gift wrap','2026-11-27 14:29:11');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (20,8,2,44.0,'pending',NULL,'2026-11-01 15:42:18');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (18,11,3,123.0,'refunded','leave at the door','2026-11-02 16:55:25');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (24,3,1,12.5,'paid','gift wrap','2026-11-03 17:08:32');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (7,9,2,37.0,'shipped','call before delivery','2026-11-04 18:21:39');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (10,1,3,74.7,'refunded','leave at the door','2026-11-05 19:34:46');
INSERT INTO orders (customer_id,product_id,quantity,total,status,note,created_at) VALUES (18,4,3,267.0,'pending',NULL,'2026-11-06 20:47:53');
