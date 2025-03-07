/*
 * 功能：根据用户定义的时间范围和研究区范围，搜索Landsat影像元数据信息
 * 支持的卫星：Landsat 4、5、7、8、9
 * 输出内容：影像元数据表格（CSV格式），包含以下信息：
 *   - 影像ID
 *   - 云量
 *   - 获取日期
 *   - 获取时间（格林尼治时间）
 *   - 获取时间（北京时间）
 *   - 年份
 *   - 月份
 *   - Path
 *   - Row
 */

// 选择研究区域
var geometry = table;

// 获取研究区域名称（从table的路径中提取最后一段）
var tableId = ee.String(table.get('system:id'));
var areaName = tableId.split('/').get(-1);

// 设置时间范围
var date_start = '2023-01-01';
var date_end = '2023-12-31';

// 设置云量筛选范围（百分比）
var cloud_min = 0;  // 云量下限
var cloud_max = 100; // 云量上限

// 构建文件名中的日期和云量信息
var dateInfo = date_start.replace(/-/g, '') + '_' + date_end.replace(/-/g, '');
var cloudInfo = 'cloud_' + cloud_min + '_' + cloud_max;

// 数字补零函数
function padZero(num) {
  return num < 10 ? '0' + num : '' + num;
}

// 字符串重复函数
function repeatStr(str, times) {
  var result = '';
  for (var i = 0; i < times; i++) {
    result += str;
  }
  return result;
}

// 字符串填充函数
function padString(str, length, padChar) {
  str = String(str);
  if (str.length >= length) {
    return str;
  }
  return str + repeatStr(padChar || ' ', length - str.length);
}

// 计算东八区时间
function calcBeijingTime(centerTime) {
  // 解析UTC时间 (格式: "HH:MM:SS.SSSSSSSZ")
  var parts = centerTime.split(':');
  var hours = parseInt(parts[0], 10);
  var minutes = parseInt(parts[1], 10);
  var seconds = parseFloat(parts[2]);  // 包含小数部分
  
  // 添加8小时得到北京时间
  hours = (hours + 8) % 24;
  
  // 格式化输出
  return padZero(hours) + ':' + padZero(minutes) + ':' + padZero(Math.floor(seconds));
}

// 获取Landsat影像集合
// Landsat 4
var L4collection = ee.ImageCollection('LANDSAT/LT04/C02/T1_L2')
  .filterBounds(geometry)
  .filterDate(date_start, date_end)
  .filter(ee.Filter.and(
    ee.Filter.gte('CLOUD_COVER', cloud_min),
    ee.Filter.lte('CLOUD_COVER', cloud_max)
  ));

// Landsat 5
var L5collection = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
  .filterBounds(geometry)
  .filterDate(date_start, date_end)
  .filter(ee.Filter.and(
    ee.Filter.gte('CLOUD_COVER', cloud_min),
    ee.Filter.lte('CLOUD_COVER', cloud_max)
  ));

// Landsat 7
var L7collection = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
  .filterBounds(geometry)
  .filterDate(date_start, date_end)
  .filter(ee.Filter.and(
    ee.Filter.gte('CLOUD_COVER', cloud_min),
    ee.Filter.lte('CLOUD_COVER', cloud_max)
  ));

// Landsat 8
var L8collection = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
  .filterBounds(geometry)
  .filterDate(date_start, date_end)
  .filter(ee.Filter.and(
    ee.Filter.gte('CLOUD_COVER', cloud_min),
    ee.Filter.lte('CLOUD_COVER', cloud_max)
  ));

// Landsat 9
var L9collection = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
  .filterBounds(geometry)
  .filterDate(date_start, date_end)
  .filter(ee.Filter.and(
    ee.Filter.gte('CLOUD_COVER', cloud_min),
    ee.Filter.lte('CLOUD_COVER', cloud_max)
  ));

// 合并所有卫星的影像集合
var mergedCollection = ee.ImageCollection(L4collection
  .merge(L5collection)
  .merge(L7collection)
  .merge(L8collection)
  .merge(L9collection));

// 打印有效影像数量
print('总影像数量:', mergedCollection.size());
print('云量筛选范围:', cloud_min + '% - ' + cloud_max + '%');

// 计算覆盖研究区所需的不同条带号影像
var pathRowList = mergedCollection.map(function(image) {
  return ee.Feature(null, {
    'WRS_PATH': image.get('WRS_PATH'),
    'WRS_ROW': image.get('WRS_ROW')
  });
}).distinct(['WRS_PATH', 'WRS_ROW']);

// 评估并打印结果
pathRowList.evaluate(function(result) {
  var count = result.features.length;
  
  print('\n覆盖研究区影像条带号信息:');
  print('若要完全覆盖研究区，需要' + count + '张不同条带号的影像，条带号信息为：');
  
  // 创建分隔线
  var separatorLine = repeatStr('-', 20);
  print(separatorLine);
  
  // 打印每个Path/Row组合
  result.features.forEach(function(feature) {
    var path = feature.properties.WRS_PATH;
    var row = feature.properties.WRS_ROW;
    print('path=' + path + ',row=' + row);
  });
  
  print(separatorLine);
});

// 遍历集合中的每个图像并收集信息
mergedCollection.evaluate(function(collection) {
  // 创建表头
  var header = ['序号', '影像ID', '云量', '获取日期', '获取时间(UTC)', '获取时间(北京时间)', '年份', '月份', 'Path', 'Row'];
  var tableData = [header];
  var featureList = [];
  
  // 计算表格列宽
  var columnWidths = header.map(function(col) { return col.length; });
  
  collection.features.forEach(function(feature, index) {
    var id = feature.id;
    var cloudCover = feature.properties.CLOUD_COVER.toFixed(2) + '%';
    var dateAcquired = feature.properties.DATE_ACQUIRED;
    var sceneCenterTime = feature.properties.SCENE_CENTER_TIME;
    var beijingTime = calcBeijingTime(sceneCenterTime);
    var num = (index + 1).toString();
    var path = feature.properties.WRS_PATH;
    var row = feature.properties.WRS_ROW;
    
    // 提取年份和月份
    var dateParts = dateAcquired.split('-');
    var year = dateParts[0];
    var month = dateParts[1];
    
    // 添加数据行
    var row_data = [num, id, cloudCover, dateAcquired, sceneCenterTime, beijingTime, year, month, path, row];
    tableData.push(row_data);
    
    // 更新列宽
    row_data.forEach(function(cell, i) {
      columnWidths[i] = Math.max(columnWidths[i], String(cell).length);
    });
    
    // 创建用于导出的Feature
    featureList.push(ee.Feature(null, {
      'number': num,
      'image_id': id,
      'cloud_cover': cloudCover,
      'date_acquired': dateAcquired,
      'scene_center_time_utc': sceneCenterTime,
      'scene_center_time_beijing': beijingTime,
      'year': year,
      'month': month,
      'path': path,
      'row': row
    }));
  });
  
  // 打印表格
  print('\n影像详细信息表:');
  
  // 创建分隔线
  var totalWidth = columnWidths.reduce(function(sum, width) { 
    return sum + width; 
  }) + columnWidths.length * 3 - 1;
  
  var separatorLine = repeatStr('=', totalWidth);
  print(separatorLine);
  
  tableData.forEach(function(row, rowIndex) {
    var formattedRow = row.map(function(cell, i) {
      return String(cell) + repeatStr(' ', columnWidths[i] - String(cell).length);
    }).join(' | ');
    print('| ' + formattedRow + ' |');
    
    // 在表头后打印分隔线
    if (rowIndex === 0) {
      print(repeatStr('-', totalWidth));
    }
  });
  print(separatorLine);
  
  // 创建FeatureCollection并导出到CSV
  var featureCollection = ee.FeatureCollection(featureList);
  Export.table.toDrive({
    collection: featureCollection,
    description: areaName.getInfo() + '_' + dateInfo + '_' + cloudInfo + '_metadata',
    fileFormat: 'CSV',
    selectors: [
      'number',
      'image_id',
      'cloud_cover',
      'date_acquired',
      'scene_center_time_utc',
      'scene_center_time_beijing',
      'year',
      'month',
      'path',
      'row'
    ]
  });
});

// 显示研究区域
Map.centerObject(geometry, 10);
Map.addLayer(geometry, {'color': 'red'}, '研究区域');