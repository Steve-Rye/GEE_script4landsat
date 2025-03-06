/**
 * @fileoverview 基于Landsat卫星数据的NDWI时间序列分析工具
 * 
 * 本模块提供了一套完整的工具，用于计算特定研究区域内的NDWI（归一化差异水体指数）时间序列均值。
 * 支持Landsat 4/5/7/8/9卫星数据的处理，包含云掩膜、异常值处理等功能。
 * 
 * 参考文献：
 * [1] McFeeters, S. K. "The use of the normalized difference water index (NDWI) in the delineation of open water features." 
 *     International journal of remote sensing 17.7 (1996): 1425-1432.
 * [2] USGS. "Landsat 8-9 Collection 2 (C2) Level 2 Science Product Guide." (2022).
 * [3] Zhu, Zhe, and Curtis E. Woodcock. "Object-based cloud and cloud shadow detection in Landsat imagery." 
 *     Remote sensing of environment 118 (2012): 83-94.
 * 
 * NDWI值范围解释 (示例):
 * [0.3, 1.0]  - 水体
 * [0.0, 0.3)  - 湿地或水汽
 * [-0.3, 0.0) - 植被或土壤
 * [-1.0, -0.3) - 雪、云、岩石或其他非水体
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
 * 为不同Landsat卫星选择合适的Green和NIR波段
 * @param {string} satellite - 卫星标识符 ('L4', 'L5', 'L7', 'L8', 'L9')
 * @return {Object} 包含Green和NIR波段名称的对象
 */
function getBandNames(satellite) {
  if (satellite === 'L8' || satellite === 'L9') {
    return {nir: 'SR_B5', green: 'SR_B3'}; // L8/L9: Green-B3, NIR-B5
  } else {
    return {nir: 'SR_B4', green: 'SR_B2'}; // L4/L5/L7: Green-B2, NIR-B4
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
 * 计算NDWI并进行异常值处理
 * @param {ee.Image} image - 输入影像
 * @param {string} satellite - 卫星标识符
 * @return {ee.Image} 添加了NDWI波段的影像
 */
function computeNDWI(image, satellite) {
  var bands = getBandNames(satellite);

  // 计算NDWI
  var ndwi = image.expression(
    '(green - nir) / (green + nir)', {
      'green': image.select(bands.green).multiply(0.0000275).add(-0.2),
      'nir': image.select(bands.nir).multiply(0.0000275).add(-0.2)
    }
  ).rename('NDWI');

  // 限制NDWI值域在[-1,1]范围内
  ndwi = ndwi.where(ndwi.lt(-1), -1).where(ndwi.gt(1), 1);

  return image.addBands(ndwi);
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
 * 主函数：计算研究区域的NDWI时间序列统计
 * @param {Object} params - 参数对象
 * @param {ee.Geometry} params.geometry - 研究区域几何对象
 * @param {string} params.startDate - 起始日期 (YYYY-MM-DD)
 * @param {string} params.endDate - 结束日期 (YYYY-MM-DD)
 * @param {string} params.satelliteId - 卫星标识符
 * @param {string} params.outputPath - GDrive导出路径
 * @return {ee.Dictionary} 统计结果
 */
exports.calculateNDWIStats = function(params) { // 注意函数名改为 calculateNDWIStats
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
      return computeNDWI(image, params.satelliteId); // 注意函数名改为 computeNDWI
    });

  printInfo('发现的影像数量: ' + collection.size().getInfo());
  printInfo('有效处理的影像数量: ' + processedCollection.size().getInfo());

  // 计算NDWI均值
  var meanNDWI = processedCollection // 注意变量名改为 meanNDWI
    .select('NDWI') // 注意波段名改为 NDWI
    .mean();

  // 准备输出结果
  var stats = {
    imageCount: processedCollection.size(),
    meanNDWI: meanNDWI.reduceRegion({ // 注意变量名改为 meanNDWI
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
    image: meanNDWI.float(), // 注意变量名改为 meanNDWI
    description: areaName + '_NDWI_mean_' + params.startDate + '_' + params.endDate, // 注意文件名改为 NDWI
    folder: params.outputPath,
    region: params.geometry,
    scale: 30,
    maxPixels: 1e9,
    fileFormat: 'GeoTIFF'
  });

  // 添加到地图显示
  Map.centerObject(params.geometry, 9);
  Map.addLayer(params.geometry, {color: 'red'}, '研究区域');
  Map.addLayer(meanNDWI.clip(params.geometry), { // 注意变量名改为 meanNDWI
    min: -1,
    max: 1,
    palette: [
      'FFFFFF', // 非水体
      'CCF0FA',
      '99E1FA',
      '66D1FA',
      '33C1FA',
      '00B2FA', // 水体
      '00A2E5',
      '0092CC',
      '0082B2',
      '007299'
    ]
  }, 'NDWI均值'); // 注意图层名改为 NDWI均值

  return ee.Dictionary(stats);
};

// 使用示例
var aoi = table; // 用户自定义研究区域

var params = {
  geometry: aoi,
  startDate: '2020-01-01',
  endDate: '2020-12-31',
  satelliteId: 'L8',
  outputPath: 'NDWI_Results' // 注意输出路径改为 NDWI_Results
};

var results = exports.calculateNDWIStats(params); // 注意函数名改为 calculateNDWIStats
print('分析结果:', results);