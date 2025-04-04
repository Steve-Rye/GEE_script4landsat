/**
 * @fileoverview 基于Landsat卫星数据的NDVI时间序列分析工具
 *
 * 本模块提供了一套完整的工具，用于计算特定研究区域内的NDVI（归一化植被指数）时间序列统计值（均值或最大值）。
 * 支持Landsat 4/5/7/8/9卫星数据的处理，包含云掩膜、异常值处理等功能，支持多时间段批量处理。
 */

// 定义支持的卫星数据集
var SATELLITES = {
  L4: {name: 'LANDSAT/LT04/C02/T1_L2', startYear: 1982, endYear: 1993},
  L5: {name: 'LANDSAT/LT05/C02/T1_L2', startYear: 1984, endYear: 2012},
  L7: {name: 'LANDSAT/LE07/C02/T1_L2', startYear: 1999, endYear: 2022},
  L8: {name: 'LANDSAT/LC08/C02/T1_L2', startYear: 2013, endYear: null},
  L9: {name: 'LANDSAT/LC09/C02/T1_L2', startYear: 2021, endYear: null}
};

// 卫星配置（可修改）
var satelliteConfig = {
  'L9': true,  // Landsat 9
  'L8': true,  // Landsat 8
  'L7': false,  // Landsat 7
  'L5': true,  // Landsat 5
  'L4': true   // Landsat 4
};

// 设置时间段列表（示例）
var timePeriods = [
  {start: '2020-01-01', end: '2020-12-31'},
  {start: '2019-01-01', end: '2019-12-31'},
  {start: '2018-01-01', end: '2018-12-31'}
];

// 选择统计方式：'mean' 或 'max'
var statType = 'mean';

/**
 * 对Landsat影像进行云和云阴影掩膜处理
 * @param {ee.Image} image - 输入影像
 * @return {ee.Image} 掩膜后的影像
 */
function maskClouds(image) {
  var qa = image.select('QA_PIXEL');
  var cloudMask = qa.bitwiseAnd(1 << 3).or(qa.bitwiseAnd(1 << 4));
  return image.updateMask(cloudMask.not());
}

/**
 * 计算NDVI并进行异常值处理
 * @param {ee.Image} image - 输入影像
 * @return {ee.Image} 添加了NDVI波段的影像
 */
function computeNDVI(image) {
  // 获取卫星ID并判断波段
  var spacecraftId = ee.String(image.get('SPACECRAFT_ID'));
  var isNewSatellite = spacecraftId.match('LANDSAT_[89]').length().gt(0);
  
  // 根据卫星类型选择波段
  var nir = ee.String(ee.Algorithms.If(isNewSatellite, 'SR_B5', 'SR_B4'));
  var red = ee.String(ee.Algorithms.If(isNewSatellite, 'SR_B4', 'SR_B3'));
  
  // 计算NDVI
  var ndvi = image.expression(
    '(nir - red) / (nir + red)', {
      'nir': image.select(nir).multiply(0.0000275).add(-0.2),
      'red': image.select(red).multiply(0.0000275).add(-0.2)
    }
  ).rename('NDVI');

  // 限制NDVI值域在[-1,1]范围内
  ndvi = ndvi.where(ndvi.lt(-1), -1).where(ndvi.gt(1), 1);

  return image.addBands(ndvi);
}

/**
 * 从影像集合中提取路径行信息
 * @param {ee.ImageCollection} collection - Landsat影像集合
 * @return {ee.List} WRS-2系统的路径行号列表
 */
function extractPathRows(collection) {
  var features = collection.map(function(image) {
    var path = ee.Number(image.get('WRS_PATH'));
    var row = ee.Number(image.get('WRS_ROW'));
    return ee.Feature(null, {
      'pathRow': ee.String(path).cat('_').cat(row),
      'path': path,
      'row': row
    });
  });

  return ee.FeatureCollection(features)
    .distinct(['pathRow'])
    .aggregate_array('pathRow');
}

/**
 * 处理单个时间段的NDVI计算
 * @param {string} startDate - 起始日期
 * @param {string} endDate - 结束日期
 * @param {ee.Geometry} geometry - 研究区域
 * @param {string} outputPath - 输出路径
 * @return {ee.Dictionary} 处理结果
 */
function processNDVI(startDate, endDate, geometry, outputPath) {
  // 获取启用的卫星列表
  var enabledSatellites = Object.keys(satelliteConfig).filter(function(sat) {
    return satelliteConfig[sat];
  });

  // 合并所有启用卫星的数据
  var mergedCollection = ee.ImageCollection([]);
  enabledSatellites.forEach(function(satellite) {
    var collection = ee.ImageCollection(SATELLITES[satellite].name)
      .filterDate(startDate, endDate)
      .filterBounds(geometry);
    
    mergedCollection = mergedCollection.merge(collection);
  });

  // 处理影像集合
  var processedCollection = mergedCollection
    .map(maskClouds)
    .map(computeNDVI);

  // 计算NDVI统计值
  var statNDVI = processedCollection
    .select('NDVI')
    [statType]();

  // 获取研究区域名称
  var areaName = ee.String(table.get('system:id')).split('/').get(-1);

  // 准备输出文件名
  // 格式化日期字符串
  var startDateFormatted = ee.String(startDate).replace('-', '').replace('-', '');
  var endDateFormatted = ee.String(endDate).replace('-', '').replace('-', '');
  
  // 构建文件名
  var filename = ee.String(areaName)
    .cat('_NDVI_')
    .cat(statType)
    .cat('_')
    .cat(startDateFormatted)
    .cat('_')
    .cat(endDateFormatted);

  // 导出GeoTIFF
  Export.image.toDrive({
    image: statNDVI.float(),
    description: filename.getInfo(),
    folder: outputPath,
    region: geometry,
    scale: 30,
    maxPixels: 1e9,
    fileFormat: 'GeoTIFF'
  });

  // 添加到地图显示
  var displayName = startDate + '至' + endDate + ' NDVI ' + (statType === 'mean' ? '均值' : '最大值');
  Map.addLayer(statNDVI.clip(geometry), {
    min: -1,
    max: 1,
    palette: [
      '#FFFFFF', '#FDE9A7', '#D9C893', '#B5B080', 
      '#91986C', '#6D8059', '#4A6845', '#275032', '#04381E'
    ]
  }, displayName);

  // 返回处理结果
  return ee.Dictionary({
    period: ee.String(startDate).cat('_').cat(endDate),
    totalImages: mergedCollection.size(),
    processedImages: processedCollection.size(),
    statType: statType,
    filename: filename
  });
}

// 获取启用的卫星列表
var enabledSatellites = Object.keys(satelliteConfig).filter(function(sat) {
  return satelliteConfig[sat];
});

// 主处理流程
print('=== NDVI批量处理开始 ===');
print('统计方式:', statType);
print('启用的卫星:', enabledSatellites);

// 显示研究区域
Map.centerObject(table);
Map.addLayer(table, {color: 'red'}, '研究区域');

// 处理所有时间段
timePeriods.forEach(function(period) {
  var result = processNDVI(period.start, period.end, table, 'NDVI_Results');
  result.evaluate(function(info) {
    print('\n时间段处理结果:', info);
  });
});

print('=== NDVI批量处理完成 ===');