-- MySQL dump 10.13  Distrib 8.4.0, for Linux (x86_64)
--
-- Host: 127.0.0.1    Database:
-- ------------------------------------------------------

/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `ventas` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `ventas`;

DROP TABLE IF EXISTS `facturas`;
CREATE TABLE `facturas` (
  `id` int NOT NULL,
  `importe` decimal(8,2) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `facturas` VALUES (1,10.00),(2,20.50);

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `crm` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `crm`;

DROP TABLE IF EXISTS `contactos`;
CREATE TABLE `contactos` (
  `id` int NOT NULL,
  `email` varchar(120) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `contactos` VALUES (1,'ana@example.invalid');

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
