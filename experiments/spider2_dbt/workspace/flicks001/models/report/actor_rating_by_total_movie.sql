-- actor_rating_by_total_movie
-- Calculates average IMDb and TMDb ratings for each actor
-- based on the movies they appeared in (Netflix dataset)

with credits as (
    select * from {{ ref('stg_netflix__credits') }}
    where role = 'ACTOR'
),

movies as (
    select * from {{ ref('stg_netflix__movies') }}
),

actor_ratings as (
    select
        c.person_id                              as actor_id,
        c.name                                   as actor_name,
        round(avg(m.IMDB_SCORE), 2)              as avg_imdb_rating,
        round(avg(m.TMDB_SCORE), 2)              as avg_tmdb_rating
    from credits c
    inner join movies m
        on c.id = m.ID
    group by c.person_id, c.name
)

select
    actor_id,
    actor_name,
    avg_imdb_rating,
    avg_tmdb_rating
from actor_ratings
