-- MySQL dump 10.13  Distrib 5.7.44, for Linux (x86_64)
--
-- Host: localhost    Database: tienda_demo
-- ------------------------------------------------------
-- Server version	5.7.44

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

--
-- Current Database: `tienda_demo`
--

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tienda_demo` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `tienda_demo`;

--
-- Table structure for table `categorias`
--

DROP TABLE IF EXISTS `categorias`;
CREATE TABLE `categorias` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nombre` varchar(40) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4;

LOCK TABLES `categorias` WRITE;
/*!40000 ALTER TABLE `categorias` DISABLE KEYS */;
INSERT INTO `categorias` VALUES (1,'Libros'),(2,'Música');
/*!40000 ALTER TABLE `categorias` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Temporary table structure for view `v_cat`
--

DROP TABLE IF EXISTS `v_cat`;
/*!50001 DROP VIEW IF EXISTS `v_cat`*/;
/*!50001 CREATE TABLE `v_cat` (
  `nombre` tinyint NOT NULL
) ENGINE=MyISAM */;

--
-- Final view structure for view `v_cat`
--

/*!50001 DROP TABLE IF EXISTS `v_cat`*/;
/*!50001 DROP VIEW IF EXISTS `v_cat`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `v_cat` AS select `categorias`.`nombre` AS `nombre` from `categorias` */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;

-- Dump completed on 2026-10-07 12:00:00
