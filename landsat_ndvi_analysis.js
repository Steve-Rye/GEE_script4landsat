/**
 * @fileoverview 基于Landsat卫星数据的NDVI时间序列分析工具
 * 
 * 本模块提供了一套完整的工具，用于计算特定研究区域内的NDVI（归一化植被指数）时间序列均值。
 * 支持Landsat 4/5/7/8/9卫星数据的处理，包含云掩膜、异常值处理等功能。
 * 
 * 参考文献：
 * [1] Rouse Jr, J., et al. "Monitoring vegetation systems in the Great Plains with ERTS." NASA special publication 351 (1974): 309.
 * [2] USGS. "Landsat 8-9 Collection 2 (C2) Level 2 Science Product Guide." (2022).
 * [3] Zhu, Zhe, and Curtis E. Woodcock. "Object-based cloud and cloud shadow detection in Landsat imagery." 
 *     Remote sensing of environment 118 (2012): 83-94.
 * 
 * NDVI值范围解释：
 * [-1.0, 0.1)  - 水体、建筑物、云层等非植被区域
 *  [0.1, 0.2)  - 裸露土壤或极稀疏植被
 *  [0.2, 0.4)  - 稀疏植被或senescent植被
 *  [0.4, 0.6)  - 中等密度植被
 *  [0.6, 1.0]  - 高密度、健康的植被
 */

// 定义支持的卫星数据集
var SATELLITES = {
  L4: {name: 'LANDSAT/LT04/C02/T1_L2', startYear: 1982, endYear: 1993},
  L5: {name: 'LANDSAT/LT05/C02/T1_L2', startYear: 1984, endYear: 2012},
  L7: {name: 'LANDSAT/LE07/C02/T1_L2', startYear: 1999, endYear: 2022},
  L8: {name: 'LANDSAT/LC08/C02/T1_L2', startYear: 2013, endYear: null},
  L9: {name: 'LANDSAT/LC09/C02/T1_L2', startYear: 2021, endYear: null}
};

/**
 * 为不同Landsat卫星选择合适的NIR和Red波段
 * @param {string} satellite - 卫星标识符 ('L4', 'L5', 'L7', 'L8', 'L9')
 * @return {Object} 包含NIR和Red波段名称的对象
 */
function getBandNames(satellite) {
  if (satellite === 'L8' || satellite === 'L9') {
    return {nir: 'SR_B5', red: 'SR_B4'};
  } else {
    return {nir: 'SR_B4', red: 'SR_B3'};
  }
}

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
 * @param {string} satellite - 卫星标识符
 * @return {ee.Image} 添加了NDVI波段的影像
 */
function computeNDVI(image, satellite) {
  var bands = getBandNames(satellite);
  
  // 计算NDVI
  var ndvi = image.expression(
    '(nir - red) / (nir + red)', {
      'nir': image.select(bands.nir).multiply(0.0000275).add(-0.2),
      'red': image.select(bands.red).multiply(0.0000275).add(-0.2)
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
  // 将每个影像的路径行信息转换为Feature
  var features = collection.map(function(image) {
    var path = ee.Number(image.get('WRS_PATH'));
    var row = ee.Number(image.get('WRS_ROW'));
    return ee.Feature(null, {
      'pathRow': ee.String(path).cat('_').cat(row),
      'path': path,
      'row': row
    });
  });
  
  // 使用pathRow属性去重并提取唯一值
  return ee.FeatureCollection(features).distinct(['pathRow']).aggregate_array('pathRow');
}

// 添加打印调试信息的函数
var printInfo = function(msg) { print('信息:', msg); };

/**
 * 主函数：计算研究区域的NDVI时间序列统计
 * @param {Object} params - 参数对象
 * @param {ee.Geometry} params.geometry - 研究区域几何对象
 * @param {string} params.startDate - 起始日期 (YYYY-MM-DD)
 * @param {string} params.endDate - 结束日期 (YYYY-MM-DD)
 * @param {string} params.satelliteId - 卫星标识符
 * @param {string} params.outputPath - GDrive导出路径
 * @return {ee.Dictionary} 统计结果
 */
exports.calculateNDVIStats = function(params) {
  // 验证输入参数
  if (!SATELLITES[params.satelliteId]) {
    throw new Error('不支持的卫星类型: ' + params.satelliteId);
  }
  
  // 获取影像集合
  var collection = ee.ImageCollection(SATELLITES[params.satelliteId].name)
    .filterDate(params.startDate, params.endDate)
    .filterBounds(params.geometry);
  
  // 提取影像集合中的路径行信息
  var pathRows = extractPathRows(collection);
  
  // 处理影像集合
  var processedCollection = collection
    .map(function(image) {
      return maskClouds(image);
    })
    .map(function(image) {
      return computeNDVI(image, params.satelliteId);
    });
  
  printInfo('发现的影像数量: ' + collection.size().getInfo());
  printInfo('有效处理的影像数量: ' + processedCollection.size().getInfo());
  
  // 计算NDVI均值
  var meanNDVI = processedCollection
    .select('NDVI')
    .mean();
  
  // 准备输出结果
  var stats = {
    imageCount: processedCollection.size(),
    meanNDVI: meanNDVI.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: params.geometry,
      scale: 30,
      maxPixels: 1e9
    }),
    temporalRange: {
      start: params.startDate,
      end: params.endDate
    },
    pathRowsInfo: {
      count: pathRows.size(),
      list: pathRows.getInfo()
    }
  };
  
  // 导出GeoTIFF
  Export.image.toDrive({
    image: meanNDVI,
    description: 'NDVI_mean_' + params.startDate + '_' + params.endDate,
    folder: params.outputPath,
    region: params.geometry,
    scale: 30,
    maxPixels: 1e9,
    fileFormat: 'GeoTIFF'
  });
  
  // 添加到地图显示
  Map.centerObject(params.geometry, 9);
  Map.addLayer(params.geometry, {color: 'red'}, '研究区域');
  Map.addLayer(meanNDVI.clip(params.geometry), {
    min: -1,
    max: 1,
    palette: [
      '#FFFFFF', // 水体/非植被 (-1.0 to 0.1)
      '#CE7E45', // 裸土 (0.1 to 0.2)
      '#DF923D', // 稀疏植被 (0.2 to 0.4)
      '#88B053', // 中等植被 (0.4 to 0.6)
      '#336622'  // 密集植被 (0.6 to 1.0)
    ]
  }, 'NDVI均值');
  
  return ee.Dictionary(stats);
};

// 使用示例
var aoi = ee.Geometry.Rectangle([116.0, 39.8, 116.5, 40.0]); // 北京市部分区域

var params = {
  geometry: aoi,
  startDate: '2020-01-01',
  endDate: '2020-12-31',
  satelliteId: 'L8',
  outputPath: 'NDVI_Results'
};

var results = exports.calculateNDVIStats(params);
print('分析结果:', results);