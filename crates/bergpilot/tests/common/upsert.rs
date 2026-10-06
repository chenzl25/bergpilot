//! Changes written the way RisingWave's upsert Iceberg sink writes them:
//! through iceberg-rust's `DeltaWriter`, keyed on the primary key. Deleting a
//! row written earlier in the same commit becomes a position delete; any
//! other delete becomes an equality delete on the key. An update is a delete
//! followed by an insert. Every commit carries RisingWave's
//! `risingwave.commit.epoch` snapshot property.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use datafusion::arrow::array::{ArrayRef, Float64Array, Int32Array, Int64Array, StringArray};
use datafusion::arrow::datatypes::{DataType, Field, Schema as ArrowSchema};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::parquet::file::properties::WriterProperties;
use iceberg::arrow::{arrow_schema_to_schema, schema_to_arrow_schema};
use iceberg::spec::{DataFile, DataFileFormat, NestedField, PrimitiveType, Schema, Type};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::writer::base_writer::data_file_writer::DataFileWriterBuilder;
use iceberg::writer::base_writer::equality_delete_writer::{
    EqualityDeleteFileWriterBuilder, EqualityDeleteWriterConfig,
};
use iceberg::writer::base_writer::position_delete_file_writer::{
    POSITION_DELETE_SCHEMA, PositionDeleteFileWriterBuilder,
};
use iceberg::writer::delta_writer::{DELETE_OP, DeltaWriterBuilder, INSERT_OP};
use iceberg::writer::file_writer::ParquetWriterBuilder;
use iceberg::writer::file_writer::location_generator::{
    DefaultFileNameGenerator, DefaultLocationGenerator,
};
use iceberg::writer::file_writer::rolling_writer::RollingFileWriterBuilder;
use iceberg::writer::{IcebergWriter, IcebergWriterBuilder, PositionDeleteInput};
use iceberg::{Catalog, NamespaceIdent, TableCreation, TableIdent};
use serde_json::{Value, json};

/// The snapshot property RisingWave's sink sets on each commit.
pub const COMMIT_EPOCH: &str = "risingwave.commit.epoch";

#[derive(Clone, Copy, Debug)]
pub enum Change {
    Upsert(i64, &'static str, f64),
    Delete(i64),
}

#[derive(Clone, Debug, PartialEq)]
struct Account {
    name: String,
    balance: f64,
}

/// `<namespace>.accounts(id bigint primary key, name string, balance double)`,
/// plus the rows it should contain after every change written so far.
pub struct UpsertTable {
    pub catalog: Arc<dyn Catalog>,
    pub ident: TableIdent,
    expected: BTreeMap<i64, Account>,
    epoch: u64,
}

impl UpsertTable {
    pub async fn create(catalog: Arc<dyn Catalog>, namespace: &str) -> Self {
        let namespace = NamespaceIdent::new(namespace.to_owned());
        catalog
            .create_namespace(&namespace, HashMap::new())
            .await
            .unwrap();
        let schema = Schema::builder()
            .with_fields(vec![
                NestedField::required(1, "id", Type::Primitive(PrimitiveType::Long)).into(),
                NestedField::optional(2, "name", Type::Primitive(PrimitiveType::String)).into(),
                NestedField::optional(3, "balance", Type::Primitive(PrimitiveType::Double)).into(),
            ])
            .with_identifier_field_ids([1])
            .build()
            .unwrap();
        catalog
            .create_table(
                &namespace,
                TableCreation::builder()
                    .name("accounts".to_owned())
                    .schema(schema)
                    .build(),
            )
            .await
            .unwrap();
        Self {
            catalog,
            ident: TableIdent::new(namespace, "accounts".to_owned()),
            expected: BTreeMap::new(),
            epoch: 0,
        }
    }

    /// Write `changes` and commit them as the next epoch. Returns the
    /// committed files.
    pub async fn commit(&mut self, changes: &[Change]) -> Vec<DataFile> {
        let (files, epoch) = self.write(changes).await;
        commit_files(self.catalog.as_ref(), &self.ident, files.clone(), epoch).await;
        files
    }

    /// Write `changes` as the next epoch without committing them, for a test
    /// to commit at a moment of its choosing with [`commit_files`].
    pub async fn write(&mut self, changes: &[Change]) -> (Vec<DataFile>, u64) {
        self.epoch += 1;
        let table = self.catalog.load_table(&self.ident).await.unwrap();
        let mut ids = Vec::new();
        let mut names = Vec::new();
        let mut balances = Vec::new();
        let mut ops = Vec::new();
        let mut push = |id: i64, account: &Account, op: i32| {
            ids.push(id);
            names.push(account.name.clone());
            balances.push(account.balance);
            ops.push(op);
        };
        for change in changes {
            match *change {
                Change::Upsert(id, name, balance) => {
                    if let Some(old) = self.expected.get(&id) {
                        push(id, old, DELETE_OP);
                    }
                    let new = Account {
                        name: name.to_owned(),
                        balance,
                    };
                    push(id, &new, INSERT_OP);
                    self.expected.insert(id, new);
                }
                Change::Delete(id) => {
                    if let Some(old) = self.expected.remove(&id) {
                        push(id, &old, DELETE_OP);
                    }
                }
            }
        }

        let arrow_schema = schema_to_arrow_schema(table.metadata().current_schema()).unwrap();
        let mut fields: Vec<Field> = arrow_schema
            .fields()
            .iter()
            .map(|field| field.as_ref().clone())
            .collect();
        fields.push(Field::new("op", DataType::Int32, false));
        let columns: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(ids)),
            Arc::new(StringArray::from(names)),
            Arc::new(Float64Array::from(balances)),
            Arc::new(Int32Array::from(ops)),
        ];
        let batch = RecordBatch::try_new(Arc::new(ArrowSchema::new(fields)), columns).unwrap();

        let mut writer = delta_writer(&table, self.epoch).build(None).await.unwrap();
        writer.write(batch).await.unwrap();
        (writer.close().await.unwrap(), self.epoch)
    }

    /// Record that `id` was deleted by a change written outside this helper.
    pub fn forget(&mut self, id: i64) {
        self.expected.remove(&id);
    }

    /// The rows the table should contain, ordered by id, in the shape the
    /// query API returns them.
    pub fn expected_rows(&self) -> Value {
        Value::Array(
            self.expected
                .iter()
                .map(|(id, account)| {
                    json!([
                        id.to_string(),
                        account.name,
                        format!("{:?}", account.balance)
                    ])
                })
                .collect(),
        )
    }

    pub const SELECT_ALL: &str = "SELECT id, name, balance FROM local.sales.accounts ORDER BY id";
}

/// Commit data and delete files in one snapshot, as RisingWave's committer
/// does, tagged with `epoch`.
pub async fn commit_files(
    catalog: &dyn Catalog,
    ident: &TableIdent,
    files: Vec<DataFile>,
    epoch: u64,
) {
    let table = catalog.load_table(ident).await.unwrap();
    let tx = Transaction::new(&table);
    let tx = tx
        .fast_append()
        .set_snapshot_properties(HashMap::from([(
            COMMIT_EPOCH.to_owned(),
            epoch.to_string(),
        )]))
        .add_data_files(files)
        .apply(tx)
        .unwrap();
    tx.commit(catalog).await.unwrap();
}

/// A position delete file for `positions` of the data file at `path`.
pub async fn position_delete_file(table: &Table, path: &str, positions: &[i64]) -> Vec<DataFile> {
    let rolling = RollingFileWriterBuilder::new_with_default_file_size(
        ParquetWriterBuilder::new(
            WriterProperties::builder().build(),
            Arc::new(POSITION_DELETE_SCHEMA.clone()),
        ),
        table.file_io().clone(),
        DefaultLocationGenerator::new(table.metadata()).unwrap(),
        DefaultFileNameGenerator::new(
            "racing".to_owned(),
            Some("pos-del".to_owned()),
            DataFileFormat::Parquet,
        ),
    );
    let mut writer = PositionDeleteFileWriterBuilder::new(rolling)
        .build(None)
        .await
        .unwrap();
    writer
        .write(
            positions
                .iter()
                .map(|&pos| PositionDeleteInput::new(Arc::from(path), pos))
                .collect(),
        )
        .await
        .unwrap();
    writer.close().await.unwrap()
}

fn delta_writer(table: &Table, epoch: u64) -> impl IcebergWriterBuilder<R = impl IcebergWriter> {
    let schema = table.metadata().current_schema().clone();
    let file_io = table.file_io().clone();
    let locations = DefaultLocationGenerator::new(table.metadata()).unwrap();
    let names = |kind: &str| {
        DefaultFileNameGenerator::new(
            format!("epoch{epoch}"),
            Some(kind.to_owned()),
            DataFileFormat::Parquet,
        )
    };
    let data = DataFileWriterBuilder::new(RollingFileWriterBuilder::new_with_default_file_size(
        ParquetWriterBuilder::new(WriterProperties::builder().build(), schema.clone()),
        file_io.clone(),
        locations.clone(),
        names("data"),
    ));
    let position_deletes =
        PositionDeleteFileWriterBuilder::new(RollingFileWriterBuilder::new_with_default_file_size(
            ParquetWriterBuilder::new(
                WriterProperties::builder().build(),
                Arc::new(POSITION_DELETE_SCHEMA.clone()),
            ),
            file_io.clone(),
            locations.clone(),
            names("pos-del"),
        ));
    let config = EqualityDeleteWriterConfig::new(vec![1], schema.clone()).unwrap();
    let equality_schema = arrow_schema_to_schema(config.projected_arrow_schema_ref()).unwrap();
    let equality_deletes = EqualityDeleteFileWriterBuilder::new(
        RollingFileWriterBuilder::new_with_default_file_size(
            ParquetWriterBuilder::new(
                WriterProperties::builder().build(),
                Arc::new(equality_schema),
            ),
            file_io,
            locations,
            names("eq-del"),
        ),
        config,
    );
    DeltaWriterBuilder::new(data, position_deletes, equality_deletes, vec![1], schema)
}
