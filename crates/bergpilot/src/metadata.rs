//! Turning Iceberg table metadata into API types.

use iceberg::spec::{NestedFieldRef, Schema, TableMetadata, Type};
use iceberg::table::Table;

use crate::types::{
    CurrentTotals, PartitionFieldInfo, RefInfo, RefKind, SchemaField, SnapshotInfo, SortFieldInfo,
    TableDetail,
};

/// `totals` are the current snapshot's, from [`crate::files::current_totals`].
pub fn table_detail(catalog: &str, table: &Table, totals: CurrentTotals) -> TableDetail {
    let metadata = table.metadata();
    let schema = metadata.current_schema();
    let column = |source_id: i32| {
        schema
            .name_by_field_id(source_id)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("field {source_id}"))
    };

    let mut snapshots: Vec<SnapshotInfo> = metadata
        .snapshots()
        .map(|snapshot| SnapshotInfo {
            snapshot_id: snapshot.snapshot_id().to_string(),
            parent_id: snapshot.parent_snapshot_id().map(|id| id.to_string()),
            sequence_number: snapshot.sequence_number(),
            timestamp_ms: snapshot.timestamp_ms(),
            operation: snapshot.summary().operation.as_str().to_owned(),
            summary: snapshot
                .summary()
                .additional_properties
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        })
        .collect();
    snapshots.sort_by_key(|snapshot| (snapshot.timestamp_ms, snapshot.sequence_number));

    TableDetail {
        catalog: catalog.to_owned(),
        namespace: table.identifier().namespace().as_ref().clone(),
        name: table.identifier().name().to_owned(),
        location: metadata.location().to_owned(),
        metadata_location: table.metadata_location().map(str::to_owned),
        format_version: metadata.format_version() as u8,
        uuid: metadata.uuid().to_string(),
        last_updated_ms: metadata.last_updated_ms(),
        current_snapshot_id: metadata.current_snapshot_id().map(|id| id.to_string()),
        schema_id: metadata.current_schema_id(),
        schema: flatten_schema(schema),
        partition_fields: metadata
            .default_partition_spec()
            .fields()
            .iter()
            .map(|field| PartitionFieldInfo {
                name: field.name.clone(),
                source: column(field.source_id),
                transform: field.transform.to_string(),
            })
            .collect(),
        sort_fields: metadata
            .default_sort_order()
            .fields
            .iter()
            .map(|field| SortFieldInfo {
                source: column(field.source_id),
                transform: field.transform.to_string(),
                direction: field.direction.to_string(),
                null_order: field.null_order.to_string(),
            })
            .collect(),
        properties: metadata
            .properties()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        snapshots,
        refs: refs(metadata),
        totals,
    }
}

/// The current schema as a flat list in display order.
pub fn flatten_schema(schema: &Schema) -> Vec<SchemaField> {
    let mut out = Vec::new();
    for field in schema.as_struct().fields() {
        push_field(&mut out, field, "", 0);
    }
    out
}

fn push_field(out: &mut Vec<SchemaField>, field: &NestedFieldRef, parent: &str, depth: u32) {
    let path = if parent.is_empty() {
        field.name.clone()
    } else {
        format!("{parent}.{}", field.name)
    };
    out.push(SchemaField {
        id: field.id,
        name: field.name.clone(),
        path: path.clone(),
        depth,
        data_type: type_name(&field.field_type),
        required: field.required,
        doc: field.doc.clone(),
    });
    match field.field_type.as_ref() {
        Type::Struct(inner) => {
            for child in inner.fields() {
                push_field(out, child, &path, depth + 1);
            }
        }
        Type::List(list) => push_field(out, &list.element_field, &path, depth + 1),
        Type::Map(map) => {
            push_field(out, &map.key_field, &path, depth + 1);
            push_field(out, &map.value_field, &path, depth + 1);
        }
        Type::Primitive(_) | Type::Variant(_) => {}
    }
}

/// A short type name; nested types are summarized and expanded as children.
fn type_name(data_type: &Type) -> String {
    match data_type {
        Type::Primitive(primitive) => primitive.to_string(),
        Type::Struct(_) => "struct".to_owned(),
        Type::List(_) => "list".to_owned(),
        Type::Map(_) => "map".to_owned(),
        Type::Variant(_) => "variant".to_owned(),
    }
}

/// Branches and tags. `TableMetadata` keeps refs private, so read them from
/// its spec JSON form.
fn refs(metadata: &TableMetadata) -> Vec<RefInfo> {
    let Ok(value) = serde_json::to_value(metadata) else {
        return Vec::new();
    };
    let Some(refs) = value.get("refs").and_then(|refs| refs.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<RefInfo> = refs
        .iter()
        .filter_map(|(name, reference)| {
            let snapshot_id = reference.get("snapshot-id")?.as_i64()?;
            let kind = match reference.get("type")?.as_str()? {
                "tag" => RefKind::Tag,
                _ => RefKind::Branch,
            };
            Some(RefInfo {
                name: name.clone(),
                kind,
                snapshot_id: snapshot_id.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}
