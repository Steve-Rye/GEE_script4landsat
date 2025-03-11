/**
 * @fileoverview 基于 Landsat NDVI 最大值和像元二分模型计算 FVC (植被覆盖度)
 *
 * 本模块提供了一套完整的工具，用于计算特定研究区域内的 FVC (Fraction of Vegetation Cover)。
 * 支持多个时间段的计算，可选择基于 NDVI 最大值或均值，以及像元二分模型进行计算。
 * 本脚本是完全独立的实现，包含了所有必要的函数和工具。
 * 主要功能包括：
 * 1. 支持多个时间段的 FVC 计算
 * 2. 支持自定义或自动计算 NDVI_soil 和 NDVI_veg 阈值
 * 3. 基于像元二分模型计算 FVC
 * 4. 结果导出到 Google Drive，并支持可视化显示
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
 * 计算NDVI阈值（NDVI_soil和NDVI_veg）
 * @param {ee.Image} ndviImage - NDVI影像
 * @param {ee.Geometry} geometry - 研究区域几何对象
 * @return {Object} 包含NDVI_soil和NDVI_veg的对象
 */
function calculateNDVIThresholds(ndviImage, geometry) {
  var percentiles = ndviImage.reduceRegion({
    reducer: ee.Reducer.percentile([5, 95]),  // 计算5%和95%分位数
    geometry: geometry.bounds(),  // 使用研究区域的边界框
    scale: 30,
    maxPixels: 1e9,
    bestEffort: true
  });
  
  return {
    ndvi_soil: percentiles.get('NDVI_p5'),  // 5%分位数作为NDVI_soil
    ndvi_veg: percentiles.get('NDVI_p95')   // 95%分位数作为NDVI_veg
  };
}

/**
 * 计算FVC (植被覆盖度)
 * @param {ee.Image} ndviImage - NDVI影像
 * @param {number} ndvi_soil - 土壤NDVI阈值
 * @param {number} ndvi_veg - 植被NDVI阈值
 * @return {ee.Image} FVC影像
 */
function calculateFVC(ndviImage, ndvi_soil, ndvi_veg) {
  // 将数值转换为常量影像
  var soilImage = ee.Image.constant(ndvi_soil);
  var vegImage = ee.Image.constant(ndvi_veg);
  
  var fvc = ee.Image().expression(
    '(NDVI - NDVI_soil) / (NDVI_veg - NDVI_soil)', {
      'NDVI': ndviImage,
      'NDVI_soil': soilImage,
      'NDVI_veg': vegImage
    }
  );
  
  // 限制FVC值在[0,1]范围内
  fvc = fvc.where(fvc.lt(0), 0).where(fvc.gt(1), 1);
  
  return fvc.rename('FVC');
}

/**
 * 主函数：计算研究区域的FVC
 * @param {Object} params - 参数对象
 * @param {ee.Geometry} params.geometry - 研究区域几何对象
 * @param {Array<Object>} params.timePeriods - 时间段列表，每个对象包含start和end
 * @param {string} params.satelliteId - 卫星标识符
 * @param {string} [params.ndviType='max'] - NDVI计算方法 ('max' 或 'mean')
 * @param {boolean} [params.autoThreshold=false] - 是否自动计算NDVI阈值
 * @param {number} [params.ndvi_soil=0.2] - 土壤NDVI阈值（当autoThreshold为false时使用）
 * @param {number} [params.ndvi_veg=0.86] - 植被NDVI阈值（当autoThreshold为false时使用）
 * @param {string} params.outputPath - GDrive导出路径
 */
exports.calculateFVC = function(params) {
  // 验证输入参数
  if (!SATELLITES[params.satelliteId]) {
    throw new Error('不支持的卫星类型: ' + params.satelliteId);
  }

  // 设置默认值
  params.ndviType = params.ndviType || 'max';
  
  // 验证NDVI计算方法
  if (params.ndviType !== 'max' && params.ndviType !== 'mean') {
    throw new Error('不支持的NDVI计算方法: ' + params.ndviType + '。请使用 "max" 或 "mean"');
  }
  params.autoThreshold = params.autoThreshold || false;
  params.ndvi_soil = params.ndvi_soil || 0.2;
  params.ndvi_veg = params.ndvi_veg || 0.86;

  // 获取研究区域名称
  var areaName = ee.String(params.geometry.get('system:id')).getInfo().split('/').pop();
  print('研究区域:', areaName);

  // 处理每个时间段
  params.timePeriods.forEach(function(period) {
    print('处理时间段:', period.start + ' 至 ' + period.end);
    
    // 1. 获取影像集合并计算NDVI
    var collection = ee.ImageCollection(SATELLITES[params.satelliteId].name)
      .filterDate(period.start, period.end)
      .filterBounds(params.geometry)
      .map(function(image) {
        return maskClouds(image);
      })
      .map(function(image) {
        return computeNDVI(image, params.satelliteId);
      });

    print('发现的影像数量:', collection.size());
    
    // 检查是否有影像
    if (collection.size().getInfo() === 0) {
      print('警告：在时间段 ' + period.start + ' 至 ' + period.end + ' 内未找到影像');
      return;
    }

    // 2. 根据选择的方法计算NDVI
    var ndviImage;
    if (params.ndviType === 'max') {
      ndviImage = collection.select('NDVI').max();
      print('使用NDVI最大值合成');
    } else {
      ndviImage = collection.select('NDVI').mean();
      print('使用NDVI均值合成');
    }
    print('NDVI计算方法:', params.ndviType);

    var ndvi_soil, ndvi_veg;

    // 3. 获取NDVI阈值
    if (params.autoThreshold) {
      // 自动计算阈值
      var thresholds = calculateNDVIThresholds(ndviMax, params.geometry);
      ndvi_soil = thresholds.ndvi_soil;
      ndvi_veg = thresholds.ndvi_veg;

      // 验证自动计算的阈值是否有效
      if (!ndvi_soil || !ndvi_veg) {
        print('警告：自动计算阈值失败，使用默认值');
        ndvi_soil = params.ndvi_soil;
        ndvi_veg = params.ndvi_veg;
      } else {
        print('已使用自动计算的阈值：');
        print('NDVI_soil:', ndvi_soil);
        print('NDVI_veg:', ndvi_veg);
      }
    } else {
      // 使用默认值
      ndvi_soil = params.ndvi_soil;
      ndvi_veg = params.ndvi_veg;
    }

    // 4. 计算FVC
    var fvc = calculateFVC(ndviImage, ndvi_soil, ndvi_veg);

    // 5. 导出结果
    var exportDescription = areaName + '_FVC_' + params.ndviType.toUpperCase() + '_' + period.start + '_' + period.end;
    Export.image.toDrive({
      image: fvc.float(),
      description: exportDescription,
      folder: params.outputPath,
      region: params.geometry,
      scale: 30,
      maxPixels: 1e9,
      fileFormat: 'GeoTIFF'
    });

    // 6. 添加到地图显示
    Map.centerObject(params.geometry, 9);
    Map.addLayer(params.geometry, {color: 'red'}, '研究区域');
    Map.addLayer(fvc.clip(params.geometry), {
      min: 0,
      max: 1,
      palette: [
        '#FFFFFF', // 0% 植被覆盖
        '#FDE9A7',
        '#D9C893',
        '#B5B080',
        '#91986C',
        '#6D8059',
        '#4A6845',
        '#275032',
        '#04381E'  // 100% 植被覆盖
      ]
    }, 'FVC_' + params.ndviType.toUpperCase() + '_' + period.start + '_' + period.end);
  });
};

// 使用示例

var aoi = table;  // 研究区域

// 可添加多个时间序列
var timePeriods = [
  {start: '2021-01-01', end: '2021-12-31'},
  {start: '2020-02-02', end: '2020-12-31'}
];

var params = {
  geometry: aoi,
  timePeriods: timePeriods,
  satelliteId: 'L8',
  ndviType: 'max',      // 'max' 使用最大值，'mean' 使用均值
  autoThreshold: false,  // 是否自动计算阈值
  ndvi_soil: 0.2,       // 可选，默认值为 0.2
  ndvi_veg: 0.86,       // 可选，默认值为 0.86
  outputPath: 'FVC_Results'
};

exports.calculateFVC(params);
