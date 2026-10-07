-- MySQL dump 10.13  Distrib 8.4.0, for Linux (x86_64)
-- Exported with DBeaver (native mysqldump task)
--
-- Host: 127.0.0.1    Database: agenda
-- ------------------------------------------------------

/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

DROP TABLE IF EXISTS `citas`;
CREATE TABLE `citas` (
  `id` int NOT NULL,
  `cuando` datetime NOT NULL,
  `asunto` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `citas` WRITE;
INSERT INTO `citas` VALUES (1,'2026-05-01 09:00:00','Revisión'),(2,'2026-05-02 10:15:00',NULL);
UNLOCK TABLES;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
