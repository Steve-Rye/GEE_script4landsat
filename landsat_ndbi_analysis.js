/**
 * @fileoverview 基于Landsat卫星数据的NDBI时间序列分析工具
 *
 * 本模块提供了一套完整的工具，用于计算特定研究区域内的NDBI（归一化差值建筑指数）时间序列均值。
 * 支持Landsat 4/5/7/8/9卫星数据的处理，包含云掩膜、异常值处理等功能。
 *
 * 参考文献：
 * [1] Zha, Yongnian, et al. "Use of normalized difference built-up index in automatically mapping urban areas from TM imagery." International journal of remote sensing 24.3 (2003): 583-594.
 * [2] USGS. "Landsat 8-9 Collection 2 (C2) Level 2 Science Product Guide." (2022).
 * [3] Zhu, Zhe, and Curtis E. Woodcock. "Object-based cloud and cloud shadow detection in Landsat imagery."
 *     Remote sensing of environment 118 (2012): 83-94.
 *
 * NDBI值范围解释：
 * [-1.0, 0.1)  - 水体、植被、裸土等非建筑区域
 *  [0.1, 0.4)  - 低密度建筑区域
 *  [0.4, 0.7)  - 中等密度建筑区域
 *  [0.7, 1.0]  - 高密度建筑区域
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
 * 为不同Landsat卫星选择合适的SWIR和NIR波段
 * @param {string} satellite - 卫星标识符 ('L4', 'L5', 'L7', 'L8', 'L9')
 * @return {Object} 包含SWIR和NIR波段名称的对象
 */
function getBandNames(satellite) {
  if (satellite === 'L8' || satellite === 'L9') {
    return {swir: 'SR_B7', nir: 'SR_B5'};
  } else {
    return {swir: 'SR_B7', nir: 'SR_B4'};
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
 * 计算NDBI并进行异常值处理
 * @param {ee.Image} image - 输入影像
 * @param {string} satellite - 卫星标识符
 * @return {ee.Image} 添加了NDBI波段的影像
 */
function computeNDBI(image, satellite) {
  var bands = getBandNames(satellite);

  // 计算NDBI
  var ndbi = image.expression(
    '(swir - nir) / (swir + nir)', {
      'swir': image.select(bands.swir).multiply(0.0000275).add(-0.2),
      'nir': image.select(bands.nir).multiply(0.0000275).add(-0.2)
    }
  ).rename('NDBI');

  // 限制NDBI值域在[-1,1]范围内
  ndbi = ndbi.where(ndbi.lt(-1), -1).where(ndbi.gt(1), 1);

  return image.addBands(ndbi);
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
 * 主函数：计算研究区域的NDBI时间序列统计
 * @param {Object} params - 参数对象
 * @param {ee.Geometry} params.geometry - 研究区域几何对象
 * @param {string} params.startDate - 起始日期 (YYYY-MM-DD)
 * @param {string} params.endDate - 结束日期 (YYYY-MM-DD)
 * @param {string} params.satelliteId - 卫星标识符
 * @param {string} params.outputPath - GDrive导出路径
 * @return {ee.Dictionary} 统计结果
 */
exports.calculateNDBIStats = function(params) { // 函数名修改为 calculateNDBIStats
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
      return computeNDBI(image, params.satelliteId); // 函数名修改为 computeNDBI
    });

  printInfo('发现的影像数量: ' + collection.size().getInfo());
  printInfo('有效处理的影像数量: ' + processedCollection.size().getInfo());

  // 计算NDBI均值
  var meanNDBI = processedCollection // 变量名修改为 meanNDBI
    .select('NDBI') // 波段名修改为 NDBI
    .mean();

  // 准备输出结果
  var stats = {
    imageCount: processedCollection.size(),
    meanNDBI: meanNDBI.reduceRegion({ // 变量名修改为 meanNDBI
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

  // 获取研究区域名称
  var areaName = ee.String(table.get('system:id')).getInfo().split('/').pop();
  print('区域名称:', areaName);

  // 导出GeoTIFF
  Export.image.toDrive({
    image: meanNDBI.float(), // 变量名修改为 meanNDBI
    description: areaName + '_NDBI_mean_' + params.startDate + '_' + params.endDate, // 文件名修改为 NDBI
    folder: params.outputPath,
    region: params.geometry,
    scale: 30,
    maxPixels: 1e9,
    fileFormat: 'GeoTIFF'
  });

  // 添加到地图显示
  Map.centerObject(params.geometry, 9);
  Map.addLayer(params.geometry, {color: 'red'}, '研究区域');
  Map.addLayer(meanNDBI.clip(params.geometry), { // 变量名修改为 meanNDBI
    min: -1,
    max: 1,
    palette: [ // 修改为 NDBI 适用的灰度配色方案
      '#FFFFFF', // 非建筑区域 (White)
      '#F0F0F0', // 极低密度建筑 (Light Gray)
      '#D0D0D0', // 低密度建筑 (Gray)
      '#B0B0B0', // 中低密度建筑 (Dark Gray)
      '#909090', // 中密度建筑 (Darker Gray)
      '#707070', // 中高密度建筑 (Very Dark Gray)
      '#505050', // 高密度建筑 (Black)
      '#303030', // 极高密度建筑 (Very Black)
      '#101010'  // 最高密度建筑 (Deep Black)
    ]
  }, 'NDBI均值'); // 图层名修改为 NDBI均值

  return ee.Dictionary(stats);
};

// 使用示例
var aoi = table; // 用户自定义研究区域

var params = {
  geometry: aoi,
  startDate: '2020-01-01',
  endDate: '2020-12-31',
  satelliteId: 'L8',
  outputPath: 'NDBI_Results' // 输出路径修改为 NDBI_Results
};

var results = exports.calculateNDBIStats(params); // 函数名修改为 calculateNDBIStats
print('分析结果:', results);